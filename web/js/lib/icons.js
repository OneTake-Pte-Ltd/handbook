// Hand-drawn icons on a 24 by 24 grid, stroked with currentColor.
// Each icon is a list of shapes: a string is a path, otherwise [tag, attributes].

export const ICONS = {
  knowledge: ["M3 5h6a3 3 0 0 1 3 3v12a2 2 0 0 0-2-2H3z", "M21 5h-6a3 3 0 0 0-3 3v12a2 2 0 0 1 2-2h7z"],
  organization: [
    ["circle", { cx: "9", cy: "8", r: "3.5" }],
    "M2.5 20a6.5 6.5 0 0 1 13 0",
    "M16 4.8a3.5 3.5 0 0 1 0 6.4",
    "M18 14.5a6.5 6.5 0 0 1 3.5 5.5",
  ],
  reporting: ["M12 3v9h9", "M21 12a9 9 0 1 1-9-9", "M15 3.5a9 9 0 0 1 5.5 5.5"],
  settings: [
    "M4 6h9",
    "M17 6h3",
    ["circle", { cx: "15", cy: "6", r: "2" }],
    "M4 12h3",
    "M11 12h9",
    ["circle", { cx: "9", cy: "12", r: "2" }],
    "M4 18h11",
    "M19 18h1",
    ["circle", { cx: "17", cy: "18", r: "2" }],
  ],
  search: [["circle", { cx: "11", cy: "11", r: "7" }], "M20 20l-4-4"],
  bell: ["M6 16v-5a6 6 0 0 1 12 0v5l2 2H4z", "M10 21h4"],
  sparkle: [
    "M11 3l1.8 5.2L18 10l-5.2 1.8L11 17l-1.8-5.2L4 10l5.2-1.8z",
    "M19 15l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z",
  ],
  menu: ["M4 6h16", "M4 12h16", "M4 18h16"],
  close: ["M6 6l12 12", "M18 6L6 18"],
  logout: ["M14 4h5v16h-5", "M10 8l-4 4 4 4", "M6 12h11"],
  user: [["circle", { cx: "12", cy: "8", r: "4" }], "M4 21a8 8 0 0 1 16 0"],
  workspace: ["M4 21V7l8-4 8 4v14", "M9 21v-6h6v6", "M4 21h16"],
  chevronDown: ["M6 9l6 6 6-6"],
  chevronRight: ["M9 6l6 6-6 6"],
  arrowLeft: ["M19 12H5", "M11 6l-6 6 6 6"],
  check: ["M5 12l5 5 9-10"],
  copy: [["rect", { x: "8", y: "8", width: "12", height: "12", rx: "2" }], "M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"],
  key: [["circle", { cx: "8", cy: "15", r: "4" }], "M11 12l9-9", "M16 7l3 3"],
  document: ["M6 3h8l5 5v13H6z", "M14 3v5h5", "M9 13h7", "M9 17h7"],
  help: [["circle", { cx: "12", cy: "12", r: "9" }], "M9.5 9a2.5 2.5 0 0 1 5 0c0 1.7-2.5 2-2.5 4", "M12 17h.01"],
};
