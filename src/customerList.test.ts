import { describe, expect, it } from "vitest";
import { parseCustomerListCsv } from "./customerList";

const header = "JobID,Customer,Tel,Mobile,Email,Address,,,";
const row = '1300,"Example, Customer",0115 000 0000,07400000000,example@example.test,"1 Example Road, Testtown AB1 2CD",,,';

describe("customer list CSV", () => {
  it("reads the supplied export layout including trailing blank columns and preserves phones as text", () => {
    const result = parseCustomerListCsv('\uFEFF' + header + '\r\n' + row + '\r\n2279,,,,,,,,\r\n');
    expect(result.skipped_empty_rows).toBe(1);
    expect(result.customers).toEqual([{
      job_id: "1300", customer_name: "Example, Customer", telephone: "0115 000 0000", mobile: "07400000000", email: "example@example.test", address: "1 Example Road, Testtown AB1 2CD",
    }]);
  });

  it("keeps repeated names separate by JobID and accepts missing optional details", () => {
    const result = parseCustomerListCsv(header + '\n1385,Example Customer,,,,,,,\n1386,Example Customer,,,,,,,');
    expect(result.customers.map(customer => customer.job_id)).toEqual(["1385", "1386"]);
    expect(result.customers[0].email).toBe("");
  });

  it("handles quoted newlines and escaped quotes without corrupting contact records", () => {
    const result = parseCustomerListCsv(header + '\n1300,"Example ""Company""",,,,"First line\nSecond line",,,');
    expect(result.customers[0]).toMatchObject({ customer_name: 'Example "Company"', address: "First line\nSecond line" });
  });
  it("preserves addresses continued into unnamed trailing columns in the Excel export", () => {
    const result = parseCustomerListCsv(header + '\n1300,Example Customer,,,,12, Example Road, Example Town,AB1 2CD');
    expect(result.customers[0].address).toBe("12, Example Road, Example Town, AB1 2CD");
  });

  it("reads a full 3,000-customer export", () => {
    const rows = Array.from({ length: 3000 }, (_, index) => `${index + 1300},Example ${index},01150000000,07400000000,customer${index}@example.test,Example address,,,`);
    const result = parseCustomerListCsv([header, ...rows].join('\r\n'));
    expect(result.customers).toHaveLength(3000);
    expect(result.customers[2999].job_id).toBe("4299");
    expect(result.customers[2999].mobile).toBe("07400000000");
  });

  it.each([
    ["invoice CSV", "SI,ACCOUNT,4010,,01/10/2026,RM inv no.4974,Removal,575,T1,115", "column headings"],
    ["missing headings", row, "column headings"],
    ["duplicate headings", header.replace("Tel", "Customer") + '\n' + row, "column headings"],
    ["unfinished quote", header + '\n1300,"Unfinished', "unfinished quoted field"],
    ["text after quote", header + '\n' + row.replace('"Example, Customer"', '"Example"invalid'), "after a closing quote"],
    ["duplicate JobID", header + '\n' + row + '\n' + row, "JobID appears more than once"],
    ["missing JobID", header + '\n' + row.replace("1300", ""), "JobID is missing"],
    ["truncated data", header + '\n1300,Example Customer', "columns are missing"],
    ["unnamed non-address column", 'JobID,Customer,,Tel,Mobile,Email,Address\n1300,Example Customer,unexpected,,,,Example address', "without a heading"],
    ["contact with no name", header + '\n1300,,01150000000,,,,,,', "name is missing"],
    ["empty customer list", header + '\n2279,,,,,,,,', "No named customer records"],
  ])("rejects %s with a useful error", (_name, input, message) => {
    expect(() => parseCustomerListCsv(input)).toThrow(message);
  });
});
