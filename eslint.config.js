import globals from "globals";

export default [
  {
    ignores: [
      "node_modules/",
      "public/",
      "data/",
      "logs/",
      "docs/",
      "*.mjs",
    ],
  },
  {
    files: ["src/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...globals.node,
        ...globals.es2021,
      },
    },
    rules: {
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      "no-undef": "error",
      eqeqeq: ["warn", "always", { null: "ignore" }],
      "prefer-const": "warn",
      "no-constant-condition": "warn",
    },
  },
];
