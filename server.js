const express = require('express');
const dotenv = require('dotenv');
const cors = require('cors');
const connectDB = require('./config/db'); // Pfad zur db.js

// Routen-Dateien importieren
const anfrageRoutes = require('./routes/anfrageRoutes'); // <--- HINZUFÜGEN
const slotRoutes = require('./routes/slotRoutes'); // <-- HINZUFÜGEN
const kapazitaetstopfRoutes = require('./routes/kapazitaetstopfRoutes'); // <-- HINZUFÜGEN
const konfliktRoutes = require('./routes/konfliktRoutes'); // <-- HINZUFÜGEN


// Umgebungsvariablen laden
dotenv.config();

// Datenbankverbindung herstellen
if (process.env.NODE_ENV !== 'test') { // Nur verbinden, wenn nicht im Test-Modus (Jest macht das separat)
  connectDB();
}

const app = express();

// Middleware
app.use(cors()); // CORS für alle Routen aktivieren
app.use(express.json()); // Ermöglicht das Parsen von JSON-Request-Bodies
app.use(express.urlencoded({ extended: false })); // Ermöglicht das Parsen von URL-kodierten Request-Bodies

app.get('/', (req, res) => {
  res.send('Slot Buchungs API läuft!');
});

// Routen verwenden
app.use('/api/anfragen', anfrageRoutes);
app.use('/api/slots', slotRoutes); // <-- HINZUFÜGEN
app.use('/api/kapazitaetstoepfe', kapazitaetstopfRoutes); // <-- HINZUFÜGEN
app.use('/api/konflikte', konfliktRoutes); // <-- HINZUFÜGEN

// Globale Fehlerbehandlung (Beispiel, kann in middleware/errorHandler.js ausgelagert werden)
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).send('Something broke!');
});


const PORT = process.env.PORT || 5000; // Nutze den Port aus .env oder default 5000

// Starte den Server nur, wenn die Datei direkt ausgeführt wird (nicht beim Import durch Tests)
if (require.main === module && process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT} in ${process.env.NODE_ENV || 'development'} mode`);
  });
}

module.exports = app; // Exportiere die App für Supertest