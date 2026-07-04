/** @type {import('jest').Config} */
module.exports = {
  moduleFileExtensions: ["js", "json", "ts"],
  rootDir: "src",
  testRegex: ".*\\.spec\\.ts$",
  transform: {
    "^.+\\.ts$": ["ts-jest", { tsconfig: "<rootDir>/../tsconfig.json" }],
  },
  moduleNameMapper: {
    "^@fat/shared$": "<rootDir>/../../../packages/shared/src/index.ts",
  },
  collectCoverageFrom: ["**/*.ts"],
  testEnvironment: "node",
};
