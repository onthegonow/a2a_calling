const sonarjs = require("eslint-plugin-sonarjs");

module.exports = [
  {
    files: ["src/**/*.js"],
    plugins: {
      sonarjs,
    },
    rules: {
      "sonarjs/cognitive-complexity": ["warn", 15],
    },
  },
  {
    ignores: ["node_modules/", "native/"],
  },
];
