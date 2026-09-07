import { defineConfig, globalIgnores } from "eslint/config";
import nextCoreWebVitals from "eslint-config-next/core-web-vitals";

export default defineConfig([
  // Keep the starter on the flat config export that actually runs under the pinned ESLint/Next toolchain.
  ...nextCoreWebVitals,
  {
    files: ["odoo_addons/**/*.js"],
    rules: {
      // Odoo POS assets use OWL, not React; these React rules are semantically inapplicable here.
      "react-hooks/rules-of-hooks": "off",
      "react/no-direct-mutation-state": "off",
    },
  },
  globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts", "dist-desktop/**", "src-tauri/**"]),
]);
