{
  description = "Ordered Pi extensions";

  nixConfig = {
    extra-substituters = [ "https://niks3.tsubasa.moe" ];
    extra-trusted-public-keys = [ "niks3.tsubasa.moe-1:tPUzYtlqW1bgA/9otIZA9LLmwESVaEmHCrEl6pbCxOY=" ];
  };

  inputs.nixpkgs.url = "https://channels.nixos.org/nixos-unstable/nixexprs.tar.zst";

  outputs =
    { self, nixpkgs }:
    let
      inherit (nixpkgs) lib;
      forAllSystems =
        f:
        lib.genAttrs [ "aarch64-linux" "x86_64-linux" ] (
          system: f (nixpkgs.legacyPackages.${system}.extend self.overlays.default)
        );
    in
    {
      overlays.default = final: _: {
        pi-extensions = final.callPackage ./nix/package.nix { };
      };

      packages = forAllSystems (pkgs: {
        inherit (pkgs) pi-extensions;
        default = pkgs.pi-extensions;
      });

      checks = forAllSystems (pkgs: {
        inherit (pkgs) pi-extensions;
        formatting = pkgs.runCommand "formatting" { nativeBuildInputs = [ pkgs.nixfmt-rs ]; } ''
          nixfmt --check ${./flake.nix} ${./nix}/*.nix
          touch "$out"
        '';
      });

      # `nix fmt` formats every tracked Nix file; pass `--check` to only check.
      formatter = forAllSystems (
        pkgs:
        pkgs.writeShellApplication {
          name = "format-nix";
          runtimeInputs = [
            pkgs.git
            pkgs.nixfmt-rs
          ];
          text = ''
            git ls-files -z '*.nix' | xargs -0 nixfmt "$@"
          '';
        }
      );
    };
}
