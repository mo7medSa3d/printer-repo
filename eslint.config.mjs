import { defineConfig, globalIgnores } from "eslint/config";
import nextCoreWebVitals from "eslint-config-next/core-web-vitals";

export default defineConfig([
  // Keep the starter on the flat config export that actually runs under the pinned ESLint/Next toolchain.
  ...nextCoreWebVitals,
  {
    // eslint-plugin-react currently performs React-version auto-detection through
    // the removed ESLint 10 context.getFilename() API. Set the project version
    // explicitly so linting does not enter that incompatible detection path.
    settings: {
      react: {
        version: "19.2",
      },
    },
  },
  globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts", "dist-desktop/**", "src-tauri/**"]),
]);
