// jest.config.js
module.exports = {
    //preset: '@shelf/jest-mongodb', // Nutzt die Voreinstellungen für MongoDB
    testEnvironment: 'node',
    // Optional: Verzeichnis, in dem Jest nach Testdateien sucht
    // roots: ['<rootDir>/tests'],
    // Optional: Dateimuster für Testdateien
    // testMatch: ['**/__tests__/**/*.js?(x)', '**/?(*.)+(spec|test).js?(x)'],
    // Optional: Setup-Datei, die vor allen Test-Suiten ausgeführt wird (z.B. für globale Mocks)
    // setupFilesAfterEnv: ['<rootDir>/jest.setup.js'], // falls benötigt
    detectOpenHandles: true, // Hilft, offene Handles nach Tests zu finden
    forceExit: true, // Erzwingt das Beenden von Jest nach den Tests (manchmal nötig bei DB-Verbindungen)
    clearMocks: true, // Setzt Mocks zwischen Tests zurück
};