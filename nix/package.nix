{
  lib,
  stdenvNoCC,
  nodejs,
  pnpm_12,
  pnpmConfigHook,
  pnpmBuildHook,
  fetchPnpmDeps,
}:
let
  # pnpm's store format, and with it the hash of the dependencies, changes
  # between major versions. Keep it on the major version mise installs.
  pnpm = pnpm_12;
  root = ../.;
in
stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "pi-extensions";
  version = "0.1.0";

  src = lib.fileset.toSource {
    inherit root;
    fileset = lib.fileset.unions [
      (root + "/package.json")
      (root + "/pnpm-lock.yaml")
      (root + "/pnpm-workspace.yaml")
      (root + "/tsconfig.json")
      (root + "/settings.ts")
      (root + "/src")
      (root + "/vite.config.ts")
    ];
  };

  nativeBuildInputs = [
    nodejs
    pnpm
    pnpmConfigHook
    pnpmBuildHook
  ];

  pnpmDeps = fetchPnpmDeps {
    inherit (finalAttrs) pname;
    src = lib.fileset.toSource {
      inherit root;
      fileset = lib.fileset.unions [
        (root + "/package.json")
        (root + "/pnpm-lock.yaml")
        (root + "/pnpm-workspace.yaml")
      ];
    };
    inherit pnpm;
    fetcherVersion = 4;
    hash = "sha256-rQ5doHEV/iEixHqwD06Tmy8QnV4scL/Y4+M96WuSB6E=";
  };

  installPhase = ''
    runHook preInstall
    mkdir -p "$out"
    cp dist/index.js dist/settings.js "$out/"
    runHook postInstall
  '';

  meta = {
    description = "Ordered Pi extensions";
    platforms = lib.platforms.linux;
  };
})
