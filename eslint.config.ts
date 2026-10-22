import js from "@eslint/js";
import vitest from "@vitest/eslint-plugin";
import tseslint from "typescript-eslint";

export default tseslint.config(
    {
        ignores: ["dist/**", "node_modules/**"],
    },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        ...vitest.configs.recommended,
        files: ["**/*.test.ts"],
    },
);
