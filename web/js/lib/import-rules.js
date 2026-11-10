// Rules for the CSV import, shared by the browser (to list errors before
// sending) and the edge script (which checks everything again). Pure
// functions: no DOM, no database.

export const STRUCTURE_COLUMNS = ["space", "category", "category_emoji", "document", "document_description", "step"];
export const STRUCTURE_REQUIRED = ["space", "category", "document"];
export const ACCESS_COLUMNS = ["department", "space", "category", "document", "permission", "mandatory"];
export const ACCESS_REQUIRED = ["department", "space", "category", "permission", "mandatory"];
export const IMPORT_PERMISSIONS = ["view", "edit_review", "edit_publish", "none"];

const LIMITS = { space: 120, category: 120, category_emoji: 16, document: 200, document_description: 1000, step: 200, department: 80 };

// Errors are { file, line, message }.
export function checkHeader(header, file) {
  const columns = file === "structure.csv" ? STRUCTURE_COLUMNS : ACCESS_COLUMNS;
  const required = file === "structure.csv" ? STRUCTURE_REQUIRED : ACCESS_REQUIRED;
  const errors = [];
  for (const name of required) {
    if (!header.includes(name)) errors.push({ file, line: 1, message: `The required column "${name}" is missing from the header.` });
  }
  for (const name of header) {
    if (name && !columns.includes(name)) errors.push({ file, line: 1, message: `Unknown column "${name}". The columns are: ${columns.join(", ")}.` });
  }
  return errors;
}

function text(values, key) {
  return typeof values[key] === "string" ? values[key].trim() : values[key] == null ? "" : String(values[key]).trim();
}

function checkLengths(row, keys, file, line, errors) {
  for (const key of keys) {
    if (row[key] && row[key].length > LIMITS[key]) errors.push({ file, line, message: `"${key}" is too long (${LIMITS[key]} characters maximum).` });
  }
}

// rows: [{ line, values }] from parseCsv. Returns { rows, errors }.
export function validateStructureRows(rows) {
  const file = "structure.csv";
  const errors = [];
  const clean = [];
  for (const { line, values } of rows) {
    const row = {
      line,
      space: text(values, "space"),
      category: text(values, "category"),
      category_emoji: text(values, "category_emoji"),
      document: text(values, "document"),
      document_description: text(values, "document_description"),
      step: text(values, "step"),
    };
    let ok = true;
    for (const key of STRUCTURE_REQUIRED) {
      if (!row[key]) {
        errors.push({ file, line, message: `The "${key}" column is empty; it is required.` });
        ok = false;
      }
    }
    if ([...row.category_emoji].length > 4) {
      errors.push({ file, line, message: "category_emoji must be a single emoji." });
      ok = false;
    }
    const before = errors.length;
    checkLengths(row, ["space", "category", "category_emoji", "document", "document_description", "step"], file, line, errors);
    if (errors.length > before) ok = false;
    if (ok) clean.push(row);
  }
  if (!rows.length) errors.push({ file, line: 1, message: "The file has a header but no rows." });
  return { rows: clean, errors };
}

export function validateAccessRows(rows) {
  const file = "access.csv";
  const errors = [];
  const clean = [];
  for (const { line, values } of rows) {
    const row = {
      line,
      department: text(values, "department"),
      space: text(values, "space"),
      category: text(values, "category"),
      document: text(values, "document"),
      permission: text(values, "permission").toLowerCase(),
      mandatory: text(values, "mandatory").toLowerCase(),
    };
    let ok = true;
    for (const key of ACCESS_REQUIRED) {
      if (!row[key]) {
        errors.push({ file, line, message: `The "${key}" column is empty; it is required.` });
        ok = false;
      }
    }
    if (row.permission && !IMPORT_PERMISSIONS.includes(row.permission)) {
      errors.push({ file, line, message: `Unknown permission "${row.permission}". Use view, edit_review, edit_publish or none.` });
      ok = false;
    }
    if (row.permission === "none" && !row.document) {
      errors.push({ file, line, message: "none can only be used on a document row (fill in the document column)." });
      ok = false;
    }
    if (row.mandatory && row.mandatory !== "yes" && row.mandatory !== "no") {
      errors.push({ file, line, message: `mandatory must be yes or no, not "${row.mandatory}".` });
      ok = false;
    }
    const before = errors.length;
    checkLengths(row, ["department", "space", "category", "document"], file, line, errors);
    if (errors.length > before) ok = false;
    if (ok) clean.push({ ...row, mandatory: row.mandatory === "yes" });
  }
  return { rows: clean, errors };
}

// Keys used to match items by name under their parent (exact, case-sensitive).
export const keys = {
  space: (s) => s,
  category: (s, c) => JSON.stringify([s, c]),
  document: (s, c, d) => JSON.stringify([s, c, d]),
};
