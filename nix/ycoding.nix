{
  lib,
  stdenvNoCC,
  callPackage,
  bun,
  nodejs,
  sysctl,
  makeBinaryWrapper,
  models-dev,
  ripgrep,
  installShellFiles,
  versionCheckHook,
  writableTmpDirAsHomeHook,
  node_modules ? callPackage ./node-modules.nix { },
}:
stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "ycoding";
  inherit (node_modules) version src;
  inherit node_modules;

  nativeBuildInputs = [
    bun
    nodejs # for patchShebangs node_modules
    installShellFiles
    makeBinaryWrapper
    models-dev
    writableTmpDirAsHomeHook
  ];

  postPatch = ''
    # NOTE: Relax Bun version check to be a warning instead of an error
    substituteInPlace packages/script/src/index.ts \
      --replace-fail 'throw new Error(`This script requires bun@''${expectedBunVersionRange}' \
                     'console.warn(`Warning: This script requires bun@''${expectedBunVersionRange}'
  '';

  configurePhase = ''
    runHook preConfigure

    cp -R ${finalAttrs.node_modules}/. .
    patchShebangs node_modules
    patchShebangs packages/*/node_modules

    runHook postConfigure
  '';

  env.MODELS_DEV_API_JSON = "${models-dev}/dist/_api.json";
  env.YCODING_DISABLE_MODELS_FETCH = true;
  env.YCODING_VERSION = finalAttrs.version;
  env.YCODING_CHANNEL = "prod";

  buildPhase = ''
    runHook preBuild

    bun --bun ./packages/cli/script/build.ts --tui-only --single --skip-install --outdir=dist/tui

    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    install -Dm755 dist/tui/tui-*/bin/ycoding $out/bin/ycoding

    wrapProgram $out/bin/ycoding \
      --prefix PATH : ${
        lib.makeBinPath (
          [
            ripgrep
          ]
          # bun runs sysctl to detect if running on rosetta2
          ++ lib.optional stdenvNoCC.hostPlatform.isDarwin sysctl
        )
      }

    runHook postInstall
  '';

  postInstall = lib.optionalString (stdenvNoCC.buildPlatform.canExecute stdenvNoCC.hostPlatform) ''
    # trick yargs into also generating zsh completions
    installShellCompletion --cmd ycoding \
      --bash <($out/bin/ycoding completion) \
      --zsh <(SHELL=/bin/zsh $out/bin/ycoding completion)
  '';

  nativeInstallCheckInputs = [
    versionCheckHook
    writableTmpDirAsHomeHook
  ];
  doInstallCheck = true;
  versionCheckKeepEnvironment = [ "HOME" "YCODING_DISABLE_MODELS_FETCH" ];
  versionCheckProgramArg = "--version";

  passthru.env = finalAttrs.env;

  meta = {
    description = "YCoding terminal coding agent";
    license = lib.licenses.mit;
    mainProgram = "ycoding";
    inherit (node_modules.meta) platforms;
  };
})
