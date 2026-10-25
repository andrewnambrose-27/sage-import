import { parseCsvRows } from "./removalsParser";

export interface CustomerListRecord {
  job_id: string;
  customer_name: string;
  telephone: string;
  mobile: string;
  email: string;
  address: string;
}

export class CustomerListError extends Error {}

export interface CustomerListResult {
  customers: CustomerListRecord[];
  skipped_empty_rows: number;
  literal_address_quotes: number;
}

function validateCustomerCsvQuotes(source: string): void {
  let quoted = false;
  let fieldStart = true;
  let closedQuote = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === '"' && source[index + 1] === '"') index += 1;
      else if (char === '"') { quoted = false; closedQuote = true; }
    } else if (char === "," || char === "\r" || char === "\n") {
      fieldStart = true; closedQuote = false;
    } else if (char === '"') {
      if (!fieldStart || closedQuote) throw new CustomerListError("The customer CSV contains an invalid quoted field. Export it as CSV again and retry.");
      quoted = true; fieldStart = false;
    } else if (!/\s/.test(char)) {
      if (closedQuote) throw new CustomerListError("The customer CSV contains text after a closing quote. Export it as CSV again and retry.");
      fieldStart = false;
    }
  }
  if (quoted) throw new CustomerListError("The customer CSV has an unfinished quoted field. Export the complete list as CSV again and retry.");
}

/** Preserve malformed literal quotes only in the known, final address columns. */
function prepareCustomerAddressQuotes(source: string): { source: string; literalAddressQuotes: number } {
  try {
    validateCustomerCsvQuotes(source);
    return { source, literalAddressQuotes: 0 };
  } catch (error) {
    if (!(error instanceof CustomerListError)) throw error;
  }
  const lines = source.split("\n");
  const headings = (parseCsvRows(lines[0])[0] ?? []).map(cell => cell.trim().toLowerCase().replace(/[^a-z0-9]/g, ""));
  const addressColumn = headings.indexOf("address");
  if (headings[0] !== "jobid" || addressColumn < 0 || headings.slice(addressColumn + 1).some(Boolean)) return { source, literalAddressQuotes: 0 };
  let literalAddressQuotes = 0;
  for (let lineIndex = 1; lineIndex < lines.length; lineIndex += 1) {
    const rawLine = lines[lineIndex];
    const line = rawLine.replace(/\r$/, "");
    if (!/^\s*\d+\s*,/.test(line) || !line.includes('"')) continue;
    let column = 0;
    let quoted = false;
    let addressStart = -1;
    for (let index = 0; index < line.length; index += 1) {
      if (line[index] === '"' && quoted && line[index + 1] === '"') index += 1;
      else if (line[index] === '"') quoted = !quoted;
      else if (line[index] === "," && !quoted && ++column === addressColumn) { addressStart = index + 1; break; }
    }
    if (addressStart === -1) continue;
    const address = line.slice(addressStart);
    try { validateCustomerCsvQuotes(address); continue; } catch (error) {
      if (!(error instanceof CustomerListError)) throw error;
    }
    // A genuine quoted multiline address continues on a non-record line. Leave it
    // to the strict CSV reader; never consume the next customer's row as an address.
    let nextIndex = lineIndex + 1;
    while (nextIndex < lines.length && !lines[nextIndex].trim()) nextIndex += 1;
    const nextLine = lines[nextIndex];
    if (nextLine && !/^\s*\d+\s*,/.test(nextLine)) continue;
    const literalAddress = address.split(",").map(part => part.trim()).filter(Boolean).join(", ");
    lines[lineIndex] = line.slice(0, addressStart) + '"' + literalAddress.replace(/"/g, '""') + '"' + (rawLine.endsWith("\r") ? "\r" : "");
    literalAddressQuotes += 1;
  }
  return { source: lines.join("\n"), literalAddressQuotes };
}

/** Customer exports are reference data, never invoice rows or automatic Sage writes. */
export function parseCustomerListCsv(text: string): CustomerListResult {
  const prepared = prepareCustomerAddressQuotes(text.replace(/^\uFEFF/, ""));
  const source = prepared.source;
  validateCustomerCsvQuotes(source);

  const rows = parseCsvRows(source).filter(row => row.some(cell => cell.trim()));
  const headings = (rows.shift() ?? []).map(cell => cell.trim().toLowerCase().replace(/[^a-z0-9]/g, ""));
  const required = ["jobid", "customer", "tel", "mobile", "email", "address"];
  if (!required.every(name => headings.includes(name)) || required.some(name => headings.indexOf(name) !== headings.lastIndexOf(name))) {
    throw new CustomerListError("The customer CSV needs these column headings: JobID, Customer, Tel, Mobile, Email, Address. Use the Customer List Upload for this export.");
  }
  if (rows.length > 10_000) throw new CustomerListError("The customer list is too long. Upload up to 10,000 customer records at a time.");
  const indexes = required.map(name => headings.indexOf(name));
  const addressColumn = indexes[5];
  const addressContinuesToEnd = headings.slice(addressColumn + 1).every(heading => !heading);
  const seen = new Set<string>();
  const customers: CustomerListRecord[] = [];
  let skipped = 0;
  for (const [index, row] of rows.entries()) {
    const [jobId, name, telephone, mobile, email, firstAddress] = indexes.map(column => (row[column] ?? "").trim());
    // The supplied Excel export spreads comma-separated addresses into blank-headed tail columns.
    const address = addressContinuesToEnd ? row.slice(addressColumn).map(cell => cell.trim()).filter(Boolean).join(", ") : firstAddress;
    const fail = (message: string): never => { throw new CustomerListError(`Customer CSV row ${index + 2}: ${message}`); };
    if (row.some((value, column) => value.trim() && !headings[column] && !(addressContinuesToEnd && column > addressColumn))) fail("A column without a heading contains data. Check the export's column headings.");
    if (!name && ![telephone, mobile, email, address].some(Boolean)) { skipped += 1; continue; }
    if (!name) fail("Contact details are present but the customer name is missing.");
    if (row.length <= Math.max(...indexes)) fail("Some customer columns are missing. Export the complete CSV again.");
    if (!/^\d+$/.test(jobId)) fail("JobID is missing or invalid.");
    if (seen.has(jobId)) fail("JobID appears more than once. Resolve duplicate JobIDs before checking again.");
    seen.add(jobId);
    customers.push({ job_id: jobId, customer_name: name, telephone, mobile, email, address });
  }
  if (!customers.length) throw new CustomerListError("No named customer records were found in this CSV.");
  return { customers, skipped_empty_rows: skipped, literal_address_quotes: prepared.literalAddressQuotes };
}
