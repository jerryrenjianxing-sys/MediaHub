'use strict';
module.exports = {
  appId: 'com.mediahub.desktop', productName: 'MediaHub', executableName: 'MediaHub',
  copyright: 'Copyright © 2026 jerryrenjianxing-sys', asar: true,
  directories: { output: 'release', buildResources: 'resources' },
  files: ['desktop/**/*.cjs', 'dist/ui/**/*', 'package.json', '!desktop/**/fixtures/**'],
  extraResources: [
    { from: 'resources', to: 'resources', filter: ['catalog.json', 'catalog-public.pem', 'mediahub.ico'] },
    { from: 'build/native/mediahub-pipe.exe', to: 'native/mediahub-pipe.exe' },
    { from: 'agent-skill', to: 'agent-skill', filter: ['**/*', '!**/__pycache__/**'] },
    { from: 'LICENSE', to: 'LICENSE' },
    { from: 'THIRD_PARTY_NOTICES.md', to: 'THIRD_PARTY_NOTICES.md' }
  ],
  afterPack: './scripts/verify-platform.cjs',
  win: { target: [{ target: 'nsis', arch: ['x64'] }, { target: 'zip', arch: ['x64'] }], icon: 'resources/mediahub.ico', signExecutable: false, artifactName: 'MediaHub-${version}-Windows-x64.${ext}' },
  nsis: { oneClick: false, perMachine: false, allowElevation: false, allowToChangeInstallationDirectory: true, deleteAppDataOnUninstall: false, createDesktopShortcut: true, createStartMenuShortcut: true, runAfterFinish: false, differentialPackage: true, include: 'scripts/installer.nsh', artifactName: 'MediaHub-${version}-win-x64-Setup.${ext}', installerLanguages: ['zh_CN', 'en_US'] },
  publish: [{ provider: 'generic', url: 'https://raw.githubusercontent.com/jerryrenjianxing-sys/MediaHub/distribution/updates', channel: 'preview' }]
};
