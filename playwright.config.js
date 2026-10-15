import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';

export default defineConfig({
  testDir: './tests/browser',
  workers: process.env.PLANIFIKATEUR_WORKER === '1' ? 1 : 2,
  use: {
    browserName: 'chromium',
    launchOptions: {
      executablePath:
        process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ||
        (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined),
    },
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1440, height: 1000 } } },
    // Le mobile ne rejoue que les parcours d’affichage marqués @mobile (menu des projets, création,
    // rôles) : le reste de la suite vérifie une logique indépendante de la largeur d’écran.
    { name: 'mobile', grep: /@mobile/, use: { viewport: { width: 390, height: 844 } } },
  ],
});
