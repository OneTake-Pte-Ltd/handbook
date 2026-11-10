// CSV parser, written by hand (no library).
// Format: UTF-8 with or without BOM, comma-separated, first row is the header.
// Fields containing commas, quotes or line breaks are wrapped in double
// quotes, and double quotes inside a field are doubled ("").
// Works in the browser and in Node (used by the tests).

export class CsvError extends Error {
  constructor(message, line) {
    super(message);
    this.line = line;
  }
}

// Returns { header: [names], rows: [{ line, values: { name: value } }] }.
// `line` is the line number where the record starts (the header is line 1).
export function parseCsv(text) {
  let input = String(text);
  if (input.charCodeAt(0) === 0xfeff) input = input.slice(1);

  const records = [];
  let field = "";
  let record = [];
  let recordLine = 1;
  let line = 1;
  let inQuotes = false;
  let quotedFieldStart = 0;
  let fieldWasQuoted = false;

  const endField = () => {
    record.push(field);
    field = "";
    fieldWasQuoted = false;
  };
  const endRecord = () => {
    endField();
    records.push({ line: recordLine, fields: record });
    record = [];
  };

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        if (ch === "\n") line++;
        if (ch === "\r" && input[i + 1] !== "\n") line++;
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      if (field.trim() !== "" || fieldWasQuoted) {
        throw new CsvError('A quote (") appears in the middle of a field. Wrap the whole field in quotes and double the quotes inside it.', line);
      }
      field = "";
      inQuotes = true;
      fieldWasQuoted = true;
      quotedFieldStart = line;
    } else if (ch === ",") {
      endField();
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && input[i + 1] === "\n") i++;
      endRecord();
      line++;
      recordLine = line;
    } else {
      if (fieldWasQuoted && ch.trim() !== "") {
        throw new CsvError("Unexpected text after a closing quote.", line);
      }
      if (!fieldWasQuoted) field += ch;
    }
  }
  if (inQuotes) throw new CsvError("A quoted field is never closed.", quotedFieldStart);
  if (field !== "" || record.length || fieldWasQuoted) endRecord();

  // Drop fully empty lines.
  const nonEmpty = records.filter((r) => r.fields.some((f) => f.trim() !== ""));
  if (!nonEmpty.length) throw new CsvError("The file is empty.", 1);
  const [headerRecord, ...dataRecords] = nonEmpty;
  const header = headerRecord.fields.map((h) => h.trim().toLowerCase());
  const rows = dataRecords.map((r) => {
    const values = {};
    header.forEach((name, index) => {
      values[name] = (r.fields[index] ?? "").trim();
    });
    return { line: r.line, values, extra: r.fields.length > header.length };
  });
  return { header, rows };
}

// Builds a CSV file from rows (used for the example downloads).
export function toCsv(header, rows) {
  const cell = (value) => {
    const s = String(value ?? "");
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [header, ...rows].map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}
