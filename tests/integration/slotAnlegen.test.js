// tests/integration/slotAnlegen.test.js
const request = require('supertest');
const mongoose = require('mongoose');
const app = require('../../server'); // Pfad zu deiner server.js oder app.js
const {Slot, TagesSlot} = require('../../models/Slot');
const Kapazitaetstopf = require('../../models/Kapazitaetstopf');
const { parseISO, addDays, format } = require('date-fns');
const { getGlobalRelativeKW, GLOBAL_KW1_START_DATE_ISO } = require('../../utils/date.helpers'); 

// mapAbfahrtstundeToKapazitaetstopfZeitfenster - kopiere oder importiere die Funktion
function mapAbfahrtstundeToKapazitaetstopfZeitfenster(stunde) {
    if (stunde === undefined || stunde === null || stunde < 0 || stunde > 23) return null;
    if (stunde >= 5 && stunde <= 6) return '05-07';
    if (stunde >= 7 && stunde <= 8) return '07-09';
    if (stunde >= 9 && stunde <= 10) return '09-11';
    if (stunde >= 11 && stunde <= 12) return '11-13';
    if (stunde >= 13 && stunde <= 14) return '13-15';
    if (stunde >= 15 && stunde <= 16) return '15-17';
    if (stunde >= 17 && stunde <= 18) return '17-19';
    if (stunde >= 19 && stunde <= 20) return '19-21';
    if (stunde >= 21 && stunde <= 22) return '21-23';
    if (stunde === 23 || stunde === 0) return '23-01';
    if (stunde >= 1 && stunde <= 2) return '01-03';
    if (stunde >= 3 && stunde <= 4) return '03-05';
    return null;
}


describe('POST /api/slots - Slot Erstellung mit Kapazitätstopf-Logik', () => {
    //jest.setTimeout(60000);
    // Wenn du manuelle Bereinigung pro Testfall brauchst:
    beforeAll(async () => {
        // Mongoose Verbindung herstellen, wenn nicht schon global geschehen
        // Diese Verbindung muss die URI zur Docker-DB nutzen
        await mongoose.connect(process.env.TEST_MONGO_URI || 'mongodb://localhost:27017/test-mongo-slots');
    });
    
    afterAll(async () => {
        await mongoose.disconnect();
    });
    
    beforeEach(async () => {
        // Stelle sicher, dass Mongoose verbunden ist
        if (mongoose.connection.readyState === 0) {
            const testDbUri = process.env.TEST_MONGO_URI || 'mongodb://localhost:27017/test-mongo-slots';
            await mongoose.connect(testDbUri);
        }
        // Leere Collections
        const collections = mongoose.connection.collections;
        for (const key in collections) {
            const collection = collections[key];
            await collection.deleteMany({});
        }
    });

    it('sollte einen Tag-Slot erstellen und automatisch einen passenden Kapazitätstopf erzeugen, wenn keiner existiert', async () => {
        const slotData = {
            slotTyp: "TAG",
            von: "Hamburg Altona",
            bis: "Berlin Hbf",
            Abschnitt: "Hamburg - Berlin", // Wichtig für Topf-Findung/Erstellung
            Abfahrt: { stunde: 7, minute: 33 },
            Ankunft: { stunde: 9, minute: 49 },
            Verkehrstag: "Mo-Fr",       // Wichtig für Topf-Findung/Erstellung
            Kalenderwoche: 23,          // Wichtig für Topf-Findung/Erstellung
            Verkehrsart: "SPFV",         // Wichtig für Topf-Findung/Erstellung
            Grundentgelt: 150
        };

        // Aktion: Slot erstellen
        const response = await request(app)
            .post('/api/slots')
            .send(slotData);

        // Überprüfung der Antwort
        //console.log(response.body);
        expect(response.status).toBe(201);
        expect(response.body.message).toBe('Slot erfolgreich erstellt und Kapazitätstopf-Verknüpfung hergestellt/geprüft.');
        expect(response.body.data).toBeDefined();
        const erstellterSlotResponse = response.body.data;
        expect(erstellterSlotResponse.SlotID_Sprechend).toBeDefined();
        expect(erstellterSlotResponse.VerweisAufTopf).toBeDefined();
        expect(erstellterSlotResponse.VerweisAufTopf).not.toBeNull();

        // Überprüfung direkt in der Datenbank
        const erstellterSlotDB = await Slot.findById(erstellterSlotResponse._id).populate('VerweisAufTopf');
        expect(erstellterSlotDB).not.toBeNull();
        expect(erstellterSlotDB.VerweisAufTopf).not.toBeNull();

        const autoErstellterTopf = erstellterSlotDB.VerweisAufTopf; // Dies ist bereits das populierte Objekt
        expect(autoErstellterTopf).toBeInstanceOf(Kapazitaetstopf); // Prüfen, ob es ein Kapazitaetstopf-Dokument ist

        // Eigenschaften des auto-erstellten Topfes prüfen
        expect(autoErstellterTopf.Abschnitt).toBe(slotData.Abschnitt);
        expect(autoErstellterTopf.Kalenderwoche).toBe(slotData.Kalenderwoche);
        expect(autoErstellterTopf.Verkehrstag).toBe(slotData.Verkehrstag);
        expect(autoErstellterTopf.Verkehrsart).toBe(slotData.Verkehrsart); // Da ein neuer Topf die VA des Slots übernimmt

        const erwartetesZeitfenster = mapAbfahrtstundeToKapazitaetstopfZeitfenster(slotData.Abfahrt.stunde);
        expect(autoErstellterTopf.Zeitfenster).toBe(erwartetesZeitfenster);
        const erwarteteTopfIdTeile = [
            "KT",
            slotData.Abschnitt.toUpperCase().replace(/\s+/g, '-').replace(/[^a-zA-Z0-9-_]/g, ''),
            `KW${slotData.Kalenderwoche}`,
            slotData.Verkehrsart,
            slotData.Verkehrstag.replace('+', 'u'),
            `ZF${erwartetesZeitfenster.replace('-', '')}`
        ];
        expect(autoErstellterTopf.TopfID).toBe(erwarteteTopfIdTeile.join('-'));

        expect(autoErstellterTopf.TopfID).toBeDefined(); // Sollte durch Hook generiert worden sein
        expect(autoErstellterTopf.ZeitfensterStartStunde).toBeDefined(); // Sollte durch Hook generiert worden sein

        expect(autoErstellterTopf.ListeDerSlots).toHaveLength(1);
        expect(autoErstellterTopf.ListeDerSlots[0].toString()).toBe(erstellterSlotDB._id.toString());
        expect(autoErstellterTopf.maxKapazitaet).toBe(Math.floor(0.7 * 1)); // = 0     


    });

    it('sollte einen Nacht-Slot erstellen und automatisch einen passenden Kapazitätstopf erzeugen, wenn keiner existiert', async () => {
        const slotData = {
            slotTyp: "NACHT",
            von: "Hamburg Altona",
            bis: "Berlin Hbf",
            Abschnitt: "Hamburg - Berlin", // Wichtig für Topf-Findung/Erstellung            
            Verkehrstag: "Mo-Fr",       // Wichtig für Topf-Findung/Erstellung
            Kalenderwoche: 23,          // Wichtig für Topf-Findung/Erstellung            
            Grundentgelt: 150,
            Zeitfenster: '01-03',
            Mindestfahrzeit: 35,
            Maximalfahrzeit: 120
        };

        // Aktion: Slot erstellen
        const response = await request(app)
            .post('/api/slots')
            .send(slotData);

        // Überprüfung der Antwort
        //console.log(response.body);
        expect(response.status).toBe(201);
        expect(response.body.message).toBe('Slot erfolgreich erstellt und Kapazitätstopf-Verknüpfung hergestellt/geprüft.');
        expect(response.body.data).toBeDefined();
        const erstellterSlotResponse = response.body.data;
        expect(erstellterSlotResponse.SlotID_Sprechend).toBeDefined();
        expect(erstellterSlotResponse.VerweisAufTopf).toBeDefined();
        expect(erstellterSlotResponse.VerweisAufTopf).not.toBeNull();

        // Überprüfung direkt in der Datenbank
        const erstellterSlotDB = await Slot.findById(erstellterSlotResponse._id).populate('VerweisAufTopf');
        expect(erstellterSlotDB).not.toBeNull();
        expect(erstellterSlotDB.VerweisAufTopf).not.toBeNull();

        const autoErstellterTopf = erstellterSlotDB.VerweisAufTopf; // Dies ist bereits das populierte Objekt
        expect(autoErstellterTopf).toBeInstanceOf(Kapazitaetstopf); // Prüfen, ob es ein Kapazitaetstopf-Dokument ist

        // Eigenschaften des auto-erstellten Topfes prüfen
        expect(autoErstellterTopf.Abschnitt).toBe(slotData.Abschnitt);
        expect(autoErstellterTopf.Kalenderwoche).toBe(slotData.Kalenderwoche);
        expect(autoErstellterTopf.Verkehrstag).toBe(slotData.Verkehrstag);
        expect(autoErstellterTopf.Verkehrsart).toBe('ALLE'); // Da ein neuer Topf nachts ist für ALLE

        
        expect(autoErstellterTopf.Zeitfenster).toBe(slotData.Zeitfenster);
        const erwarteteTopfIdTeile = [
            "KT",
            slotData.Abschnitt.toUpperCase().replace(/\s+/g, '-').replace(/[^a-zA-Z0-9-_]/g, ''),
            `KW${slotData.Kalenderwoche}`,
            'ALLE',
            slotData.Verkehrstag.replace('+', 'u'),
            `ZF${slotData.Zeitfenster.replace('-', '')}`
        ];
        expect(autoErstellterTopf.TopfID).toBe(erwarteteTopfIdTeile.join('-'));

        expect(autoErstellterTopf.TopfID).toBeDefined(); // Sollte durch Hook generiert worden sein
        expect(autoErstellterTopf.ZeitfensterStartStunde).toBeDefined(); // Sollte durch Hook generiert worden sein

        expect(autoErstellterTopf.ListeDerSlots).toHaveLength(1);
        expect(autoErstellterTopf.ListeDerSlots[0].toString()).toBe(erstellterSlotDB._id.toString());
        expect(autoErstellterTopf.maxKapazitaet).toBe(Math.floor(0.7 * 1)); // = 0     


    });

    it('sollte aus einem Tag-Slot mit Verkehrstag täglich zwei Slots mit Mo-F und Sa+So erstellen und automatisch einen passenden Kapazitätstopf erzeugen, wenn keiner existiert', async () => {
        const slotData = {
            slotTyp: "TAG",
            von: "Hamburg Altona",
            bis: "Berlin Hbf",
            Abschnitt: "Hamburg - Berlin", // Wichtig für Topf-Findung/Erstellung
            Abfahrt: { stunde: 7, minute: 33 },
            Ankunft: { stunde: 9, minute: 49 },
            Verkehrstag: "täglich",       // Wichtig für Topf-Findung/Erstellung
            zeitraumStart: '2025-01-13',  // Wichtig für Topf-Findung/Erstellung
            zeitraumEnde: '2025-01-19',  // Wichtig für Topf-Findung/Erstellung
            Verkehrsart: "SPFV",         // Wichtig für Topf-Findung/Erstellung
            Kalenderwoche: 3,
            Grundentgelt: 150
        };

        // Aktion: Slot erstellen
        const response = await request(app)
            .post('/api/slots/massen-erstellung')
            .send(slotData);

        //console.log(response.body.message);

        // Überprüfung der Antwort
        expect(response.status).toBe(201);
        expect(response.body.message).toBe(`Massen-Erstellung abgeschlossen. 2 TAG-Slots erfolgreich erstellt. 0 Fehler aufgetreten.`);
        expect(response.body.erstellteSlots).toBeDefined();
        const erstellterSlotResponse = response.body.erstellteSlots;
        expect(erstellterSlotResponse.length).toBe(2);
        expect(erstellterSlotResponse[0].SlotID_Sprechend).toBeDefined();
        expect(erstellterSlotResponse[0].VerweisAufTopf).toBeDefined();
        expect(erstellterSlotResponse[0].VerweisAufTopf).not.toBeNull();
        expect(erstellterSlotResponse[1].SlotID_Sprechend).toBeDefined();
        expect(erstellterSlotResponse[1].VerweisAufTopf).toBeDefined();
        expect(erstellterSlotResponse[1].VerweisAufTopf).not.toBeNull();

        // Überprüfung direkt in der Datenbank
        const erstellterSlotDB1 = await Slot.findById(erstellterSlotResponse[0]._id).populate('VerweisAufTopf');
        expect(erstellterSlotDB1).not.toBeNull();
        expect(erstellterSlotDB1.VerweisAufTopf).not.toBeNull();

        const erstellterSlotDB2 = await Slot.findById(erstellterSlotResponse[1]._id).populate('VerweisAufTopf');
        expect(erstellterSlotDB2).not.toBeNull();
        expect(erstellterSlotDB2.VerweisAufTopf).not.toBeNull();

        const autoErstellterTopf1 = erstellterSlotDB1.VerweisAufTopf; // Dies ist bereits das populierte Objekt
        const autoErstellterTopf2 = erstellterSlotDB2.VerweisAufTopf;
        expect(autoErstellterTopf1).toBeInstanceOf(Kapazitaetstopf); // Prüfen, ob es ein Kapazitaetstopf-Dokument ist

        // Eigenschaften des auto-erstellten Topfes prüfen
        expect(autoErstellterTopf1.Abschnitt).toBe(slotData.Abschnitt);
        expect(autoErstellterTopf1.Kalenderwoche).toBe(slotData.Kalenderwoche);
        expect(autoErstellterTopf1.Verkehrstag).toBe('Mo-Fr');
        expect(autoErstellterTopf1.Verkehrsart).toBe(slotData.Verkehrsart); // Da ein neuer Topf die VA des Slots übernimmt

        expect(autoErstellterTopf2.Abschnitt).toBe(slotData.Abschnitt);
        expect(autoErstellterTopf2.Kalenderwoche).toBe(slotData.Kalenderwoche);
        expect(autoErstellterTopf2.Verkehrstag).toBe('Sa+So');
        expect(autoErstellterTopf2.Verkehrsart).toBe(slotData.Verkehrsart);

        const erwartetesZeitfenster = mapAbfahrtstundeToKapazitaetstopfZeitfenster(slotData.Abfahrt.stunde);
        expect(autoErstellterTopf1.Zeitfenster).toBe(erwartetesZeitfenster);
        expect(autoErstellterTopf2.Zeitfenster).toBe(erwartetesZeitfenster);
        const erwarteteTopfIdTeile = [
            "KT",
            slotData.Abschnitt.toUpperCase().replace(/\s+/g, '-').replace(/[^a-zA-Z0-9-_]/g, ''),
            `KW${slotData.Kalenderwoche}`,
            slotData.Verkehrsart,
            'Mo-Fr',
            `ZF${erwartetesZeitfenster.replace('-', '')}`
        ];
        expect(autoErstellterTopf1.TopfID).toBe(erwarteteTopfIdTeile.join('-'));

        expect(autoErstellterTopf1.TopfID).toBeDefined(); // Sollte durch Hook generiert worden sein
        expect(autoErstellterTopf1.ZeitfensterStartStunde).toBeDefined(); // Sollte durch Hook generiert worden sein

        expect(autoErstellterTopf1.ListeDerSlots).toHaveLength(1);
        expect(autoErstellterTopf1.ListeDerSlots[0].toString()).toBe(erstellterSlotDB1._id.toString());
        expect(autoErstellterTopf1.maxKapazitaet).toBe(Math.floor(0.7 * 1)); // = 0     


    });

    it('sollte einen Tag-Slot erstellen und einem existierenden Kapazitätstopf (spezifische Verkehrsart) zuordnen', async () => {
        // 1. Vorbereitung: Existierenden Kapazitätstopf erstellen
        const existierenderTopfData = {
            Abschnitt: "Strecke2",
            Kalenderwoche: 11,
            Verkehrstag: "Mo-Fr",
            Verkehrsart: "SPNV", // Spezifische Verkehrsart
            Zeitfenster: "11-13" // Abgeleitet aus Abfahrt.stunde 11 oder 12
            // TopfID wird automatisch generiert
        };
        const existierenderTopf = await new Kapazitaetstopf(existierenderTopfData).save();
        expect(existierenderTopf.ListeDerSlots).toHaveLength(0); // Initial leer
        expect(existierenderTopf.maxKapazitaet).toBe(0);       // Initial 0

        // 2. Aktion: Slot erstellen, der exakt zu diesem Topf passt
        const slotData = {
            slotTyp: "TAG",
            von: "BahnhofC",
            bis: "BahnhofD",
            Abschnitt: "Strecke2", // Passt zu existierenderTopfData.Abschnitt
            Abfahrt: { stunde: 11, minute: 30 }, // Führt zu Zeitfenster "11-13"
            Ankunft: { stunde: 12, minute: 30 },
            Verkehrstag: "Mo-Fr",   // Passt
            Kalenderwoche: 11,      // Passt
            Verkehrsart: "SPNV",     // Passt exakt
            Grundentgelt: 150
        };
        const response = await request(app)
            .post('/api/slots')
            .send(slotData);

        // 3. Überprüfung
        expect(response.status).toBe(201);
        expect(response.body.data).toBeDefined();
        const erstellterSlotResponse = response.body.data;

        // Prüfen, ob der Slot dem existierenden Topf zugeordnet wurde
        expect(erstellterSlotResponse.VerweisAufTopf).toBe(existierenderTopf._id.toString());

        // Prüfen, ob kein neuer Topf erstellt wurde (Anzahl der Töpfe sollte 1 sein)
        const anzahlToepfe = await Kapazitaetstopf.countDocuments();
        expect(anzahlToepfe).toBe(1);

        // Den existierenden Topf aus der DB laden und seine Aktualisierungen prüfen
        const ktUpdated = await Kapazitaetstopf.findById(existierenderTopf._id);
        expect(ktUpdated.ListeDerSlots).toHaveLength(1);
        expect(ktUpdated.ListeDerSlots[0].toString()).toBe(erstellterSlotResponse._id);
        expect(ktUpdated.maxKapazitaet).toBe(Math.floor(0.7 * 1)); // = 0
    });

    it('sollte einen Nacht-Slot erstellen und einem existierenden Kapazitätstopf (Verkehrsart "ALLE") zuordnen', async () => {
        // 1. Vorbereitung: Existierenden Kapazitätstopf mit Verkehrsart 'ALLE' erstellen
        const ktAlleData = {
            Abschnitt: "Strecke3",
            Kalenderwoche: 12,
            Verkehrstag: "Sa+So",
            Verkehrsart: "ALLE", // Wichtig: Topf ist für ALLE Verkehrsarten
            Zeitfenster: "23-01"
        };
        const kapazitaetstopfAlle = await new Kapazitaetstopf(ktAlleData).save();
        expect(kapazitaetstopfAlle.ListeDerSlots).toHaveLength(0);
        expect(kapazitaetstopfAlle.maxKapazitaet).toBe(0);

        // 2. Aktion: Slot erstellen, dessen spezifische Verkehrsart (SGV)
        // nur vom "ALLE"-Topf abgedeckt wird (es gibt keinen spezifischen SGV-Topf für diese Kriterien).
        const slotDataSGV = {
            slotTyp: "NACHT",
            von: "PunktE",
            bis: "PunktF",
            Abschnitt: "Strecke3",         // Passt zu ktAlleData.Abschnitt
            //Abfahrt: { stunde: 14, minute: 0 }, // Führt zu Zeitfenster "13-15"
            //Ankunft: { stunde: 14, minute: 45 },
            Verkehrstag: "Sa+So",             // Passt
            Kalenderwoche: 12,                // Passt
            //Verkehrsart: "SGV",                // Spezifische Verkehrsart des Slots
            Grundentgelt: 150,
            Zeitfenster: '23-01',
            Mindestfahrzeit: 35,
            Maximalfahrzeit: 120
        };
        const response = await request(app)
            .post('/api/slots')
            .send(slotDataSGV);

        // 3. Überprüfung
        expect(response.status).toBe(201);
        expect(response.body.data).toBeDefined();
        const erstellterSlotResponse = response.body.data;

        // Prüfen, ob der Slot dem "ALLE"-Topf zugeordnet wurde
        expect(erstellterSlotResponse.VerweisAufTopf).toBe(kapazitaetstopfAlle._id.toString());

        // Prüfen, ob kein neuer Topf erstellt wurde (Anzahl der Töpfe sollte 1 sein)
        const anzahlToepfe = await Kapazitaetstopf.countDocuments();
        expect(anzahlToepfe).toBe(1);

        // Den "ALLE"-Topf aus der DB laden und seine Aktualisierungen prüfen
        const ktAlleUpdated = await Kapazitaetstopf.findById(kapazitaetstopfAlle._id);
        expect(ktAlleUpdated.ListeDerSlots).toHaveLength(1);
        expect(ktAlleUpdated.ListeDerSlots[0].toString()).toBe(erstellterSlotResponse._id);
        expect(ktAlleUpdated.maxKapazitaet).toBe(Math.floor(0.7 * 1)); // = 0
    });

    it('sollte zwei Nacht-Slots erstellen und einem existierenden Kapazitätstopf (Verkehrsart "ALLE") zuordnen', async () => {
        // 1. Vorbereitung: Existierenden Kapazitätstopf mit Verkehrsart 'ALLE' erstellen
        const ktAlleData = {
            Abschnitt: "Strecke3",
            Kalenderwoche: 12,
            Verkehrstag: "Sa+So",
            Verkehrsart: "ALLE", // Wichtig: Topf ist für ALLE Verkehrsarten
            Zeitfenster: "23-01"
        };
        const kapazitaetstopfAlle = await new Kapazitaetstopf(ktAlleData).save();
        expect(kapazitaetstopfAlle.ListeDerSlots).toHaveLength(0);
        expect(kapazitaetstopfAlle.maxKapazitaet).toBe(0);

        // 2. Aktion: Slot erstellen, dessen spezifische Verkehrsart (SGV)
        // nur vom "ALLE"-Topf abgedeckt wird (es gibt keinen spezifischen SGV-Topf für diese Kriterien).
        const slotDataSGV = {
            slotTyp: "NACHT",
            von: "PunktE",
            bis: "PunktF",
            Abschnitt: "Strecke3",         // Passt zu ktAlleData.Abschnitt
            //Abfahrt: { stunde: 14, minute: 0 }, // Führt zu Zeitfenster "13-15"
            //Ankunft: { stunde: 14, minute: 45 },
            Verkehrstag: "Sa+So",             // Passt
            Kalenderwoche: 12,                // Passt
            //Verkehrsart: "SGV",                // Spezifische Verkehrsart des Slots
            Grundentgelt: 150,
            Zeitfenster: '23-01',
            Mindestfahrzeit: 35,
            Maximalfahrzeit: 120
        };
        let response = await request(app)
            .post('/api/slots')
            .send(slotDataSGV);

        // 3a. Überprüfung
        expect(response.status).toBe(201);
        expect(response.body.data).toBeDefined();
        let erstellterSlotResponse = response.body.data;

        // Prüfen, ob der Slot dem "ALLE"-Topf zugeordnet wurde
        expect(erstellterSlotResponse.VerweisAufTopf).toBe(kapazitaetstopfAlle._id.toString());

        // Prüfen, ob kein neuer Topf erstellt wurde (Anzahl der Töpfe sollte 1 sein)
        let anzahlToepfe = await Kapazitaetstopf.countDocuments();
        expect(anzahlToepfe).toBe(1);

        // Den "ALLE"-Topf aus der DB laden und seine Aktualisierungen prüfen
        let ktAlleUpdated = await Kapazitaetstopf.findById(kapazitaetstopfAlle._id);
        expect(ktAlleUpdated.ListeDerSlots).toHaveLength(1);
        expect(ktAlleUpdated.ListeDerSlots[0].toString()).toBe(erstellterSlotResponse._id);
        expect(ktAlleUpdated.maxKapazitaet).toBe(Math.floor(0.7 * 1)); // = 0

        response = await request(app)
            .post('/api/slots')
            .send(slotDataSGV);

        // 3b. Überprüfung
        expect(response.status).toBe(201);
        expect(response.body.data).toBeDefined();
        erstellterSlotResponse = response.body.data;

        // Prüfen, ob der Slot dem "ALLE"-Topf zugeordnet wurde
        expect(erstellterSlotResponse.VerweisAufTopf).toBe(kapazitaetstopfAlle._id.toString());

        // Prüfen, ob kein neuer Topf erstellt wurde (Anzahl der Töpfe sollte 1 sein)
        anzahlToepfe = await Kapazitaetstopf.countDocuments();
        expect(anzahlToepfe).toBe(1);

        // Den "ALLE"-Topf aus der DB laden und seine Aktualisierungen prüfen
        ktAlleUpdated = await Kapazitaetstopf.findById(kapazitaetstopfAlle._id);
        expect(ktAlleUpdated.ListeDerSlots).toHaveLength(2);
        expect(ktAlleUpdated.ListeDerSlots[1].toString()).toBe(erstellterSlotResponse._id);
        expect(ktAlleUpdated.maxKapazitaet).toBe(Math.floor(0.7 * 2)); // = 0
    });

    it('sollte mehrere Tag-Slots korrekt demselben Kapazitätstopf zuordnen und maxKapazitaet jeweils aktualisieren', async () => {
        // Daten, die für beide Slots zur Zuordnung zum selben Topf führen
        const topfKriterien = {
            Abschnitt: "Gemeinsam",
            Kalenderwoche: 15,
            Verkehrstag: "Mo-Fr",
            Verkehrsart: "SPFV", // für den Topf
            AbfahrtStundeFuerZeitfenster: 9 // ergibt Zeitfenster "09-11"
        };
        const erwartetesTopfZeitfenster = TagesSlot.mapAbfahrtstundeToKapazitaetstopfZeitfenster(topfKriterien.AbfahrtStundeFuerZeitfenster);

        // 1. Ersten Slot (SL_A) erstellen -> sollte Topf KT_Multi erzeugen
        const slotDataA = {
            slotTyp: "TAG",
            von: "StartA", bis: "EndeA", Abschnitt: topfKriterien.Abschnitt,
            Abfahrt: { stunde: topfKriterien.AbfahrtStundeFuerZeitfenster, minute: 10 },
            Ankunft: { stunde: topfKriterien.AbfahrtStundeFuerZeitfenster + 1, minute: 10 },
            Verkehrstag: topfKriterien.Verkehrstag, Kalenderwoche: topfKriterien.Kalenderwoche, Verkehrsart: topfKriterien.Verkehrsart,
            Grundentgelt: 150
        };

        const responseA = await request(app).post('/api/slots').send(slotDataA);
        expect(responseA.status).toBe(201);
        const slotA_Id = responseA.body.data._id;
        const topfId_A = responseA.body.data.VerweisAufTopf;
        expect(topfId_A).toBeDefined();

        // Überprüfung des Topfes nach dem ersten Slot
        let ktMulti = await Kapazitaetstopf.findById(topfId_A);
        expect(ktMulti).not.toBeNull();
        expect(ktMulti.ListeDerSlots).toHaveLength(1);
        expect(ktMulti.ListeDerSlots[0].toString()).toBe(slotA_Id);
        expect(ktMulti.maxKapazitaet).toBe(Math.floor(0.7 * 1)); // = 0
        expect(ktMulti.Abschnitt).toBe(topfKriterien.Abschnitt);
        expect(ktMulti.Zeitfenster).toBe(erwartetesTopfZeitfenster);
        expect(ktMulti.Verkehrsart).toBe(topfKriterien.Verkehrsart);


        // 2. Zweiten Slot (SL_B) erstellen -> sollte demselben Topf KT_Multi zugeordnet werden
        const slotDataB = {
            slotTyp: "TAG",
            von: "StartB", bis: "EndeB", Abschnitt: topfKriterien.Abschnitt, // Gleicher Abschnitt
            Abfahrt: { stunde: topfKriterien.AbfahrtStundeFuerZeitfenster, minute: 40 }, // Gleiches Zeitfenster
            Ankunft: { stunde: topfKriterien.AbfahrtStundeFuerZeitfenster + 1, minute: 40 },
            Verkehrstag: topfKriterien.Verkehrstag, Kalenderwoche: topfKriterien.Kalenderwoche, Verkehrsart: topfKriterien.Verkehrsart,
            Grundentgelt: 150
        };

        const responseB = await request(app).post('/api/slots').send(slotDataB);
        expect(responseB.status).toBe(201);
        const slotB_Id = responseB.body.data._id;
        const topfId_B = responseB.body.data.VerweisAufTopf;
        expect(topfId_B).toBeDefined();

        // Überprüfung, ob es derselbe Topf ist
        expect(topfId_B).toBe(topfId_A); // Beide Slots sollten auf denselben Topf verweisen

        // Überprüfung des Topfes nach dem zweiten Slot
        ktMulti = await Kapazitaetstopf.findById(topfId_A); // oder topfId_B, ist ja derselbe
        expect(ktMulti.ListeDerSlots).toHaveLength(2);
        // Prüfen, ob beide Slot-IDs in der Liste sind (Reihenfolge ist nicht garantiert, daher includes)
        expect(ktMulti.ListeDerSlots.map(id => id.toString())).toContain(slotA_Id);
        expect(ktMulti.ListeDerSlots.map(id => id.toString())).toContain(slotB_Id);
        expect(ktMulti.maxKapazitaet).toBe(Math.floor(0.7 * 2)); // = 1
    });

    // TESTFALL FÜR MASSENERSTELLUNG
    it('sollte über den /massen-erstellung Endpunkt korrekt 5 Tag-Slots für einen Zeitraum von 5 Wochen erstellen', async () => {
        // ---- 1. Vorbereitung: Definiere das Slot-Muster und den Zeitraum ----
        
        // Zeitraum, der 5 globale relative KWs abdeckt (hier KW 4 bis KW 8)
        // KW 4 2025 beginnt am 20.01.2025
        // KW 8 2025 endet am 23.02.2025
        const zeitraumStart = "2025-01-20";
        const zeitraumEnde = "2025-02-23";

        const payload = {
            slotTyp: "TAG",
            von: "Massen-Start",
            bis: "Massen-Ende",
            Abschnitt: "Massen-Strecke",
            Abfahrt: { stunde: 10, minute: 0 },
            Ankunft: { stunde: 11, minute: 0 },
            Verkehrstag: "Mo-Fr",
            Grundentgelt: 250,
            Verkehrsart: "SGV",
            zeitraumStart: zeitraumStart,
            zeitraumEnde: zeitraumEnde
        };

        // ---- 2. Aktion: Rufe den Endpunkt zur Massenerstellung auf ----
        const response = await request(app)
            .post('/api/slots/massen-erstellung')
            .send(payload);

        // ---- 3. Überprüfung der Antwort ----
        expect(response.status).toBe(201);
        expect(response.body.message).toContain('5 TAG-Slots erfolgreich erstellt');
        expect(response.body.erstellteSlots).toHaveLength(5);
        expect(response.body.fehler).toHaveLength(0);

        // ---- 4. Überprüfung direkt in der Datenbank ----

        // Prüfe, ob 5 Slots mit dem korrekten Abschnitt in der DB sind
        const erstellteSlotsDB = await Slot.find({ Abschnitt: "Massen-Strecke" });
        expect(erstellteSlotsDB).toHaveLength(5);

        // Prüfe, ob für jede erwartete KW (4, 5, 6, 7, 8) genau ein Slot erstellt wurde
        const kws = erstellteSlotsDB.map(s => s.Kalenderwoche).sort((a,b) => a-b);
        expect(kws).toEqual([4, 5, 6, 7, 8]);

        // Stichprobenartige Prüfung eines Slots und seines Kapazitätstopfes
        const slotFuerKW5 = erstellteSlotsDB.find(s => s.Kalenderwoche === 5);
        expect(slotFuerKW5).toBeDefined();
        expect(slotFuerKW5.von).toBe("Massen-Start");
        expect(slotFuerKW5.Grundentgelt).toBe(250);
        expect(slotFuerKW5.VerweisAufTopf).toBeDefined();
        expect(slotFuerKW5.VerweisAufTopf).not.toBeNull();

        // Überprüfe den zugehörigen, automatisch erstellten Kapazitätstopf für KW 5
        const topfFuerKW5 = await Kapazitaetstopf.findById(slotFuerKW5.VerweisAufTopf);
        expect(topfFuerKW5).not.toBeNull();
        expect(topfFuerKW5.Abschnitt).toBe("Massen-Strecke");
        expect(topfFuerKW5.Kalenderwoche).toBe(5);
        expect(topfFuerKW5.Verkehrstag).toBe("Mo-Fr");
        
        // Da wir pro Topf-Definition 2 Slots im Setup der anderen Tests erstellt hatten,
        // hier aber nur einen, sollte maxKapazitaet = 0 sein (floor(0.7*1))
        // Aber unser Controller erstellt ja nur einen Slot pro KW, also hat ListeDerSlots Länge 1
        expect(topfFuerKW5.ListeDerSlots).toHaveLength(1);
        expect(topfFuerKW5.ListeDerSlots[0].toString()).toBe(slotFuerKW5._id.toString());
        expect(topfFuerKW5.maxKapazitaet).toBe(0);
    });

    // TESTFALL FÜR MASSENERSTELLUNG
    it('sollte über den /massen-erstellung Endpunkt korrekt 2x6 Nacht-Slots für einen Zeitraum von 6 Wochen erstellen', async () => {
        // ---- 1. Vorbereitung: Definiere das Slot-Muster und den Zeitraum ----
        
        // Zeitraum, der 5 globale relative KWs abdeckt (hier KW 4 bis KW 8)
        // KW 4 2025 beginnt am 20.01.2025
        // KW 8 2025 endet am 23.02.2025
        const zeitraumStart = "2025-01-20";
        const zeitraumEnde = "2025-03-02";

        const payload = {
            slotTyp: "NACHT",
            von: "Massen-Start",
            bis: "Massen-Ende",
            Abschnitt: "Massen-Strecke",
            Verkehrstag: "Mo-Fr",
            Grundentgelt: 250,
            zeitraumStart: zeitraumStart,
            zeitraumEnde: zeitraumEnde,
            Zeitfenster: '03-05',
            Mindestfahrzeit: 35,
            Maximalfahrzeit: 120
        };

        // ---- 2. Aktion: Rufe zweimal den Endpunkt zur Massenerstellung auf ----
        let response = await request(app)
            .post('/api/slots/massen-erstellung')
            .send(payload);

        // ---- 3a. Überprüfung der Antwort ----
        expect(response.status).toBe(201);
        expect(response.body.message).toContain('6 NACHT-Slots erfolgreich erstellt');
        expect(response.body.erstellteSlots).toHaveLength(6);
        expect(response.body.fehler).toHaveLength(0);

        response = await request(app)
            .post('/api/slots/massen-erstellung')
            .send(payload);

        // ---- 3b. Überprüfung der Antwort ----
        expect(response.status).toBe(201);
        expect(response.body.message).toContain('6 NACHT-Slots erfolgreich erstellt');
        expect(response.body.erstellteSlots).toHaveLength(6);
        expect(response.body.fehler).toHaveLength(0);

        // ---- 4. Überprüfung direkt in der Datenbank ----

        // Prüfe, ob 2x6 Slots mit dem korrekten Abschnitt in der DB sind
        const erstellteSlotsDB = await Slot.find({ Abschnitt: "Massen-Strecke" });
        expect(erstellteSlotsDB).toHaveLength(12);

        // Prüfe, ob für jede erwartete KW (4, 5, 6, 7, 8, 9) genau ein Slot erstellt wurde
        const kws = erstellteSlotsDB.map(s => s.Kalenderwoche).sort((a,b) => a-b);
        expect(kws).toEqual([4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9]);

        // Stichprobenartige Prüfung eines Slots und seines Kapazitätstopfes
        const slotFuerKW9 = await Slot.findOne({ Abschnitt: "Massen-Strecke", Kalenderwoche: 9 });
        expect(slotFuerKW9).toBeDefined();
        expect(slotFuerKW9.von).toBe("Massen-Start");
        expect(slotFuerKW9.Grundentgelt).toBe(250);
        expect(slotFuerKW9.VerweisAufTopf).toBeDefined();
        expect(slotFuerKW9.VerweisAufTopf).not.toBeNull();

        // Überprüfe den zugehörigen, automatisch erstellten Kapazitätstopf für KW 5
        const topfFuerKW9 = await Kapazitaetstopf.findById(slotFuerKW9.VerweisAufTopf);
        expect(topfFuerKW9).not.toBeNull();
        expect(topfFuerKW9.Abschnitt).toBe("Massen-Strecke");
        expect(topfFuerKW9.Kalenderwoche).toBe(9);
        expect(topfFuerKW9.Verkehrstag).toBe("Mo-Fr");
        
        // Da wir pro Topf-Definition 2 Slots im Setup der anderen Tests erstellt hatten,
        // hier aber nur einen, sollte maxKapazitaet = 1 sein (floor(0.7*2))
        // Unser Controller erstellt ja pro Durchlauf einen Slot pro KW, also hat ListeDerSlots Länge 2
        expect(topfFuerKW9.ListeDerSlots).toHaveLength(2);
        expect(topfFuerKW9.ListeDerSlots[0].toString()).toBe(slotFuerKW9._id.toString());
        expect(topfFuerKW9.maxKapazitaet).toBe(1);
    });


});

describe('PUT /api/slots/:slotId - Zuordnung zu neuen Kapazitätstöpfen nach Slot-Update', () => {
        let kt_X, kt_Y, slot_X;

        // Wenn du manuelle Bereinigung pro Testfall brauchst:
        beforeAll(async () => {
        // Mongoose Verbindung herstellen, wenn nicht schon global geschehen
        // Diese Verbindung muss die URI zur Docker-DB nutzen
            await mongoose.connect(process.env.TEST_MONGO_URI || 'mongodb://localhost:27017/test-mongo-slots');
        });
    
        afterAll(async () => {
            await mongoose.disconnect();
        });

        // Setup für Update-Tests: Erstelle zwei Töpfe und einen Slot, der KT_X zugeordnet ist
        beforeEach(async () => {

            // Stelle sicher, dass Mongoose verbunden ist
            if (mongoose.connection.readyState === 0) {
                const testDbUri = process.env.TEST_MONGO_URI || 'mongodb://localhost:27017/test-mongo-slots';
                await mongoose.connect(testDbUri);
            }
            // Leere Collections
            const collections = mongoose.connection.collections;
            for (const key in collections) {
                const collection = collections[key];
                await collection.deleteMany({});
            }

            kt_X = await new Kapazitaetstopf({
                Abschnitt: "Nord", Kalenderwoche: 15, Verkehrstag: "Mo-Fr",
                Verkehrsart: "SPFV", Zeitfenster: "07-09" // TopfID wird auto-generiert
            }).save();

            kt_Y = await new Kapazitaetstopf({
                Abschnitt: "Sued", Kalenderwoche: 15, Verkehrstag: "Mo-Fr", // Gleiche KW & VT wie KT_X, aber anderer Abschnitt
                Verkehrsart: "SPFV", Zeitfenster: "09-11" // Anderes Zeitfenster
            }).save();

            const slotDataFuerKtx = {
                slotTyp: "TAG",
                von: "AA", bis: "BB", Abschnitt: "Nord",
                Abfahrt: { stunde: 8, minute: 0 }, Ankunft: { stunde: 8, minute: 50 }, // Passt zu KT_X Zeitfenster 07-09
                Verkehrstag: "Mo-Fr", Kalenderwoche: 15, Verkehrsart: "SPFV",
                Grundentgelt: 150
            };
            // Slot erstellen und manuell die Verknüpfungslogik des Controllers simulieren/durchlaufen lassen
            const createResponse = await request(app).post('/api/slots').send(slotDataFuerKtx);
            slot_X = createResponse.body.data;

            // Sicherstellen, dass die initiale Zuweisung korrekt war
            expect(slot_X.VerweisAufTopf.toString()).toBe(kt_X._id.toString());
            const tempKtx = await Kapazitaetstopf.findById(kt_X._id);
            expect(tempKtx.ListeDerSlots).toHaveLength(1);
            const slotIdStringsInListe = tempKtx.ListeDerSlots.map(id => id.toString()); // Wandle alle ObjectIds in Strings um
            expect(slotIdStringsInListe).toContain(slot_X._id.toString());
            expect(tempKtx.maxKapazitaet).toBe(0); // Math.floor(0.7*1)
        });

        
        it('sollte einen Slot aktualisieren, sodass er den Kapazitätstopf wechselt (von KT_X zu KT_Y)', async () => {
            // Aktion: Slot_X so aktualisieren, dass er zu KT_Y passt
            // Änderung des Abschnitts und der Abfahrtsstunde
            const updateDataFuerKty = {
                Abschnitt: "Sued", // Passt zu KT_Y
                Abfahrt: { stunde: 10, minute: 0 }, // Passt zu KT_Y Zeitfenster 09-11
                Grundentgelt: 350
                // Andere Felder wie von, bis, Ankunft können auch angepasst werden, wenn nötig
            };

            const response = await request(app)
                .put(`/api/slots/${slot_X._id}`)
                .send(updateDataFuerKty);

            // Überprüfung der Antwort
            expect(response.status).toBe(200);
            const aktualisierterSlotResponse = response.body.data;
            console.log(aktualisierterSlotResponse);
            expect(aktualisierterSlotResponse.VerweisAufTopf.toString()).toBe(kt_Y._id.toString()); // Sollte jetzt auf KT_Y zeigen
            expect(aktualisierterSlotResponse.Abschnitt).toBe("Sued");
            expect(aktualisierterSlotResponse.Abfahrt.stunde).toBe(10);
            expect(aktualisierterSlotResponse.Grundentgelt).toBe(350);

            // Überprüfung von KT_X (alter Topf)
            const ktX_nachUpdate = await Kapazitaetstopf.findById(kt_X._id);
            expect(ktX_nachUpdate.ListeDerSlots).toHaveLength(0); // Slot_X sollte entfernt sein
            expect(ktX_nachUpdate.maxKapazitaet).toBe(Math.floor(0.7 * 0)); // = 0

            // Überprüfung von KT_Y (neuer Topf)
            const ktY_nachUpdate = await Kapazitaetstopf.findById(kt_Y._id);
            expect(ktY_nachUpdate.ListeDerSlots).toHaveLength(1);
            const slotIdStringsInListe = ktY_nachUpdate.ListeDerSlots.map(id => id.toString()); // Wandle alle ObjectIds in Strings um
            expect(slotIdStringsInListe).toContain(slot_X._id.toString());
            expect(ktY_nachUpdate.maxKapazitaet).toBe(Math.floor(0.7 * 1)); // = 0
        });

        it('sollte einen Slot aktualisieren, sodass er von KT_A zu einem NEUEN auto-erstellten Topf KT_C wechselt', async () => {
            // Aktion: Slot_X so aktualisieren, dass er zu keinem existierenden Topf passt,
            // aber Kriterien für einen neuen Topf KT_C erfüllt.
            const updateDataFuerNeuenTopf = {
                Abschnitt: "West", // Dieser Abschnitt existiert noch nicht als Topf
                Kalenderwoche: 16,  // Andere KW
                Verkehrstag: "Sa+So",
                Verkehrsart: "SGV",
                Abfahrt: { stunde: 13, minute: 0 }, // Führt zu Zeitfenster "13-15"
                Grundentgelt: 450
            };

            const response = await request(app)
                .put(`/api/slots/${slot_X._id}`)
                .send(updateDataFuerNeuenTopf);

            // Überprüfung der Antwort
            expect(response.status).toBe(200);
            const aktualisierterSlotResponse = response.body.data;
            expect(aktualisierterSlotResponse.VerweisAufTopf).toBeDefined();
            expect(aktualisierterSlotResponse.VerweisAufTopf).not.toBeNull();
            expect(aktualisierterSlotResponse.Grundentgelt).toBe(450);
            expect(aktualisierterSlotResponse.VerweisAufTopf.toString()).not.toBe(kt_X._id.toString()); // Darf nicht mehr KT_A sein

            // Überprüfung von KT_A (alter Topf)
            const ktA_nachUpdate = await Kapazitaetstopf.findById(kt_X._id);
            expect(ktA_nachUpdate.ListeDerSlots).toHaveLength(0); // Slot_X sollte entfernt sein
            expect(ktA_nachUpdate.maxKapazitaet).toBe(0);

            // Überprüfung des neu erstellten Topfes KT_C
            const ktC_Id = aktualisierterSlotResponse.VerweisAufTopf;
            const ktC_autoErstellt = await Kapazitaetstopf.findById(ktC_Id);
            expect(ktC_autoErstellt).not.toBeNull();
            expect(ktC_autoErstellt.Abschnitt).toBe("West");
            expect(ktC_autoErstellt.Kalenderwoche).toBe(16);
            expect(ktC_autoErstellt.Verkehrstag).toBe("Sa+So");
            expect(ktC_autoErstellt.Verkehrsart).toBe("SGV");
            expect(ktC_autoErstellt.Zeitfenster).toBe(TagesSlot.mapAbfahrtstundeToKapazitaetstopfZeitfenster(13)); // "13-15"
            
            expect(ktC_autoErstellt.ListeDerSlots).toHaveLength(1);
            const slotIdStringsInListe = ktC_autoErstellt.ListeDerSlots.map(id => id.toString()); // Wandle alle ObjectIds in Strings um
            expect(slotIdStringsInListe).toContain(slot_X._id.toString());
            expect(ktC_autoErstellt.maxKapazitaet).toBe(0); // Math.floor(0.7 * 1)

            // Sicherstellen, dass nur ein neuer Topf (KT_C) erstellt wurde (insgesamt jetzt 2 Töpfe: KT_A und KT_C)
            const anzahlToepfe = await Kapazitaetstopf.countDocuments();
            expect(anzahlToepfe).toBe(3); // KT_X und KT_Y von beforeEach + der neue KT_C
        });

        
    });

    describe('DELETE /api/slots/:slotId', () => {
        let kt_DelTest, sl_1_Del, sl_2_Del;

        // Wenn du manuelle Bereinigung pro Testfall brauchst:
        beforeAll(async () => {
        // Mongoose Verbindung herstellen, wenn nicht schon global geschehen
        // Diese Verbindung muss die URI zur Docker-DB nutzen
            await mongoose.connect(process.env.TEST_MONGO_URI || 'mongodb://localhost:27017/test-mongo-slots');
        });
    
        afterAll(async () => {
            await mongoose.disconnect();
        });

        beforeEach(async () => {

            // Stelle sicher, dass Mongoose verbunden ist
            if (mongoose.connection.readyState === 0) {
                const testDbUri = process.env.TEST_MONGO_URI || 'mongodb://localhost:27017/test-mongo-slots';
                await mongoose.connect(testDbUri);
            }
            // Leere Collections
            const collections = mongoose.connection.collections;
            for (const key in collections) {
                const collection = collections[key];
                await collection.deleteMany({});
            }

            // Vorbereitung: Erstelle einen Kapazitätstopf und zwei Slots, die ihm zugeordnet sind.
            // Die Zuweisung erfolgt über die Slot-Erstellung.
            const topfKriterien = {
                Abschnitt: "LoeschTest", Kalenderwoche: 20, Verkehrstag: "Mo-Fr",
                Verkehrsart: "SGV", AbfahrtStundeFuerZeitfenster: 9 // ergibt Zeitfenster "09-11"
            };

            // Erster Slot (wird später gelöscht)
            const slotData1 = {
                slotTyp: "TAG",
                von: "L1", bis: "M1", Abschnitt: topfKriterien.Abschnitt,
                Abfahrt: { stunde: topfKriterien.AbfahrtStundeFuerZeitfenster, minute: 0 },
                Ankunft: { stunde: topfKriterien.AbfahrtStundeFuerZeitfenster, minute: 30 },
                Verkehrstag: topfKriterien.Verkehrstag, Kalenderwoche: topfKriterien.Kalenderwoche, 
                Verkehrsart: topfKriterien.Verkehrsart, 
                Grundentgelt: 150
            };
            const response1 = await request(app).post('/api/slots').send(slotData1);
            sl_1_Del = response1.body.data;
            kt_DelTest_Id = sl_1_Del.VerweisAufTopf; // ID des (ggf. auto-erstellten) Topfes

            // Zweiter Slot (bleibt bestehen)
            const slotData2 = {
                slotTyp: "TAG",
                von: "L2", bis: "M2", Abschnitt: topfKriterien.Abschnitt,
                Abfahrt: { stunde: topfKriterien.AbfahrtStundeFuerZeitfenster, minute: 15 },
                Ankunft: { stunde: topfKriterien.AbfahrtStundeFuerZeitfenster, minute: 45 },
                Verkehrstag: topfKriterien.Verkehrstag, Kalenderwoche: topfKriterien.Kalenderwoche, 
                Verkehrsart: topfKriterien.Verkehrsart,
                Grundentgelt: 150
            };
            const response2 = await request(app).post('/api/slots').send(slotData2);
            sl_2_Del = response2.body.data;

            // Überprüfe den initialen Zustand des Topfes
            kt_DelTest = await Kapazitaetstopf.findById(kt_DelTest_Id);
            expect(kt_DelTest.ListeDerSlots).toHaveLength(2);
            expect(kt_DelTest.ListeDerSlots.map(id => id.toString())).toContain(sl_1_Del._id.toString());
            expect(kt_DelTest.ListeDerSlots.map(id => id.toString())).toContain(sl_2_Del._id.toString());
            expect(kt_DelTest.maxKapazitaet).toBe(Math.floor(0.7 * 2)); // = 1
        });

        it('sollte einen Slot löschen und den zugehörigen Kapazitätstopf (ListeDerSlots, maxKapazitaet) korrekt aktualisieren', async () => {
            // Aktion: Lösche den ersten Slot (sl_1_Del)
            const deleteResponse = await request(app)
                .delete(`/api/slots/${sl_1_Del._id}`);

            // Überprüfung der Lösch-Antwort
            expect(deleteResponse.status).toBe(200); // Oder 204, je nach Implementierung im Controller
            expect(deleteResponse.body.message).toBe('Slot erfolgreich gelöscht.');

            // Überprüfung, dass der Slot wirklich aus der DB entfernt wurde
            const geloeschterSlot = await Slot.findById(sl_1_Del._id);
            expect(geloeschterSlot).toBeNull();

            // Überprüfung, dass der zweite Slot noch existiert
            const verbleibenderSlot = await Slot.findById(sl_2_Del._id);
            expect(verbleibenderSlot).not.toBeNull();
            expect(verbleibenderSlot.VerweisAufTopf.toString()).toBe(kt_DelTest._id.toString()); // Sollte immer noch auf den Topf zeigen

            // Überprüfung des Kapazitätstopfes KT_DelTest
            const ktDelTest_nachUpdate = await Kapazitaetstopf.findById(kt_DelTest._id);
            expect(ktDelTest_nachUpdate.ListeDerSlots).toHaveLength(1); // Nur noch sl_2_Del sollte drin sein
            const slotIdStringsInListe = ktDelTest_nachUpdate.ListeDerSlots.map(id => id.toString()); // Wandle alle ObjectIds in Strings um
            expect(slotIdStringsInListe).toContain(sl_2_Del._id.toString());
            expect(ktDelTest_nachUpdate.maxKapazitaet).toBe(Math.floor(0.7 * 1)); // = 0
        });

        it('sollte einen 409 Fehler zurückgeben, wenn versucht wird, einen Slot zu löschen, dem Anfragen zugewiesen sind', async () => {
            // Vorbereitung: Weise sl_1_Del eine Anfrage zu
            // (Hier muss die Anfrage nicht vollständig sein, nur die Referenz im Slot setzen)
            const dummyAnfrageId = new mongoose.Types.ObjectId();
            await Slot.findByIdAndUpdate(sl_1_Del._id, { $addToSet: { zugewieseneAnfragen: dummyAnfrageId } });

            // Aktion: Versuche, sl_1_Del zu löschen
            const deleteResponse = await request(app)
                .delete(`/api/slots/${sl_1_Del._id}`);
            
            // Überprüfung
            expect(deleteResponse.status).toBe(409);
            expect(deleteResponse.body.message).toContain('Slot kann nicht gelöscht werden, da ihm bereits Anfragen zugewiesen sind.');

            // Sicherstellen, dass der Slot und der Topf nicht verändert wurden
            const slotNichtGeloescht = await Slot.findById(sl_1_Del._id);
            expect(slotNichtGeloescht).not.toBeNull();
            const topfUnveraendert = await Kapazitaetstopf.findById(kt_DelTest._id);
            expect(topfUnveraendert.ListeDerSlots).toHaveLength(2); // Beide Slots sollten noch im Topf sein
            expect(topfUnveraendert.maxKapazitaet).toBe(1); // Entsprechend 2 Slots
        });
    });