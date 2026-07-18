# Application Composition

This directory is the composition root for the single Pi extension bundle.

`install.ts` registers feature adapters in deterministic order while expressing cross-module requirements as Effect services. `layer.ts` provides extension-lifetime capabilities and their finalizers. Feature modules must not use this order as an implicit communication channel; shared behavior belongs behind a narrow service under `src/shared/` or the feature that owns it.
