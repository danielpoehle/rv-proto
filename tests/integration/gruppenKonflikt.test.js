// tests/integration/gruppenKonflikt.test.js
const request = require('supertest');
const mongoose = require('mongoose');
const app = require('../../server'); // Pfad zu deiner server.js
const Slot = require('../../models/Slot');
const Kapazitaetstopf = require('../../models/Kapazitaetstopf');
const Anfrage = require('../../models/Anfrage');
const KonfliktDokumentation = require('../../models/KonfliktDokumentation');
const KonfliktGruppe = require('../../models/KonfliktGruppe');
const { parseISO, addDays } = require('date-fns');

// Globale Konstante für den KW1-Start
const GLOBAL_KW1_START_DATE_ISO = "2024-12-30T00:00:00.000Z";


describe('Gruppierte Konfliktlösung', () => {
    let anfrage_A, anfrage_B;
    let erstellteSlots = [];
    let erstellteKonfliktDokus = [];
    const grundentgelt = 100;
    const anzahlWochen = 3;

    // Wenn du manuelle Bereinigung pro Testfall brauchst:
        beforeAll(async () => {
            // Mongoose Verbindung herstellen, wenn nicht schon global geschehen
            // Diese Verbindung muss die URI zur Docker-DB nutzen
            await mongoose.connect(process.env.TEST_MONGO_URI || 'mongodb://localhost:27017/test-mongo-slots');
        });
    
        afterAll(async () => {
            await mongoose.disconnect();
        });

    // Diese Funktion wird vor jedem Test ausgeführt
    beforeEach(async () => {
        // 0. Datenbank leeren
        if (mongoose.connection.readyState === 0) {
                const testDbUri = process.env.TEST_MONGO_URI || 'mongodb://localhost:27017/test-mongo-slots';
                await mongoose.connect(testDbUri);
        }
        // Leere Collections
        const collections = mongoose.connection.collections;        
        for (const key in collections) {
            //console.log(key);
            const collection = collections[key];
            await collection.deleteMany({});
        }

        // 1. Slots und Kapazitätstöpfe erstellen
        // Wir erstellen für 3 Wochen (KW 1, 2, 3) jeweils einen Mo-Fr und einen Sa+So Slot
        // für denselben Abschnitt. Das sind 6 Slot-Muster, die 6 Töpfe erzeugen.
        // Jeder Topf hat eine maxKapazitaet von 1 (erstellt durch 2 Slots pro Topf-Definition).
        const commonSlotParams = {
            von: "Gruppenstadt-A", bis: "Gruppenstadt-B", Abschnitt: "Gruppen-Strecke",
            Verkehrsart: "SPFV", Abfahrt: { stunde: 9, minute: 0 }, Ankunft: { stunde: 10, minute: 0 },
            Grundentgelt: grundentgelt
        };

        for (let kw = 1; kw <= anzahlWochen; kw++) {
            for (const vt of ["Mo-Fr", "Sa+So"]) {
                // Erstelle 2 Slots pro Topf-Definition, um maxKap=1 zu erhalten
                await request(app).post('/api/slots').send({ ...commonSlotParams, Kalenderwoche: kw, Verkehrstag: vt });
                const resp = await request(app).post('/api/slots').send({ ...commonSlotParams, Kalenderwoche: kw, Verkehrstag: vt, Abfahrt: { stunde: 9, minute: 10 }, Ankunft: { stunde: 10, minute: 10 } });
                erstellteSlots = await Slot.find({});
            }
        }
        expect(erstellteSlots.length).toBe(12); //2 Slots in 3 Wochen in den 2 Töpfen Mo-Fr und Sa+So sind 12 Slots insgesamt
        const topfCheck = await Kapazitaetstopf.findOne({ Abschnitt: "Gruppen-Strecke", Kalenderwoche: 1, Verkehrstag: "Mo-Fr" });
        expect(topfCheck.maxKapazitaet).toBe(1); // floor(0.7*2) = 1

        // 2. Zwei Anfragen erstellen, die beide "täglich" über 3 Wochen verkehren
        const anfrageZeitraum = {
            start: GLOBAL_KW1_START_DATE_ISO, // Start KW 1
            ende: addDays(parseISO(GLOBAL_KW1_START_DATE_ISO), (anzahlWochen * 7) - 1) // Ende KW 3
        };
        const anfrageBasis = {
            EVU: "GruppenEVU", Email: "gruppe@evu.com", Verkehrsart: "SPFV", Verkehrstag: "täglich",
            ListeGewuenschterSlotAbschnitte: [{ von: "Gruppenstadt-A", bis: "Gruppenstadt-B", Abfahrtszeit: { stunde: 9, minute: 0 }, Ankunftszeit: { stunde: 10, minute: 0 } }],
            Zeitraum: anfrageZeitraum, Status: "validiert"
        };

        anfrage_A = await new Anfrage({ ...anfrageBasis, Zugnummer: "GA" }).save();
        anfrage_B = await new Anfrage({ ...anfrageBasis, Zugnummer: "GB" }).save();        

        // 3. Zuordnungsprozess für beide Anfragen anstoßen -> Erzeugt die Konfliktsituation
        await request(app).post(`/api/anfragen/${anfrage_A._id}/zuordnen`).send();
        await request(app).post(`/api/anfragen/${anfrage_B._id}/zuordnen`).send();

        // 4. Konflikterkennung anstoßen -> Erzeugt die KonfliktDokumentationen und die KonfliktGruppe
        const identResp = await request(app).post('/api/konflikte/identifiziere-topf-konflikte').send();
        expect(identResp.body.neuErstellteKonflikte).toHaveLength(6);
        erstellteKonfliktDokus = await KonfliktDokumentation.find({});
        //console.log(erstellteKonfliktDokus);
        //let gruppen = await KonfliktGruppe.find({});
        //console.log(gruppen);
    });

    // ----- TEST 1: GRUPPEN-IDENTIFIZIERUNG -----
    it('sollte korrekt eine Konfliktgruppe mit 6 Konflikten und 2 beteiligten Anfragen identifizieren', async () => {
        // Aktion
        const response = await request(app).get('/api/konflikte/gruppen').send();
        //console.log(response.body);

        // Überprüfung
        expect(response.status).toBe(200);
        expect(response.body.data).toHaveLength(1); // Es sollte genau eine Gruppe geben

        const gruppe = response.body.data[0];
        expect(gruppe.konflikteInGruppe).toHaveLength(6);
        expect(gruppe.beteiligteAnfragen).toHaveLength(2);

        const beteiligteIds = gruppe.beteiligteAnfragen.map(a => a._id.toString());
        expect(beteiligteIds).toContain(anfrage_A._id.toString());
        expect(beteiligteIds).toContain(anfrage_B._id.toString());
    });

    // ----- TEST 2: GRUPPEN-KONFLIKTLÖSUNG (PHASE 1) -----
    it('sollte eine Gruppenentscheidung (Verzicht) korrekt auf alle 6 Konflikte anwenden und diese lösen', async () => {
        // Setup: Holen der gruppenId
        const gruppenResp = await request(app).get('/api/konflikte/gruppen').send();
        //console.log(gruppenResp.body);
        const gruppe = gruppenResp.body.data[0];
        const gruppenId = gruppe.konflikteInGruppe[0]; // Falsch: gruppenId ist die _id der Gruppe
        const konfliktGruppe = await KonfliktGruppe.findOne({ gruppenSchluessel: gruppe.gruppenSchluessel });
        const gruppenId_korrekt = konfliktGruppe._id;

        // Aktion: Anfrage B verzichtet für die gesamte Gruppe
        const updatePayload = {
            konfliktDokumentIds: gruppe.konflikteInGruppe.map(k => k._id), // Identifiziert die Gruppe
            ListeAnfragenMitVerzicht: [anfrage_B._id.toString()]
        };

        const loesenResponse = await request(app)
            .put(`/api/konflikte/gruppen/${gruppenId_korrekt}/verzicht-verschub`) // Neuer Endpunkt mit :gruppenId
            .send(updatePayload);

        //console.log(loesenResponse.body);

        // Überprüfung
        expect(loesenResponse.status).toBe(200);
        expect(loesenResponse.body.data.gruppe.status).toBe('vollstaendig_geloest');
        expect(loesenResponse.body.data.zusammenfassung.anzahlKonflikteInGruppe).toBe(6);
        expect(loesenResponse.body.data.zusammenfassung.davonGeloest).toBe(6);
        expect(loesenResponse.body.data.zusammenfassung.davonOffen).toBe(0);
        
        const gruppe_final = await KonfliktGruppe.findById(gruppenId_korrekt);
        expect(gruppe_final.status).toBe('vollstaendig_geloest');

        // Stichprobenartige Prüfung eines der 6 Konfliktdokumente
        const einKonflikt_final = await KonfliktDokumentation.findById(erstellteKonfliktDokus[0]._id);
        expect(einKonflikt_final.status).toBe('geloest');
        expect(einKonflikt_final.zugewieseneAnfragen).toHaveLength(1);
        expect(einKonflikt_final.zugewieseneAnfragen[0].toString()).toBe(anfrage_A._id.toString());
        expect(einKonflikt_final.ListeAnfragenMitVerzicht).toHaveLength(1);
        expect(einKonflikt_final.ListeAnfragenMitVerzicht[0].toString()).toBe(anfrage_B._id.toString());

        // Überprüfung des Status von Anfrage B
        const anfrage_B_final = await Anfrage.findById(anfrage_B._id);
        // Da A_B für ALLE ihre 6 Topf-Konflikte einen Verzicht eingetragen hat,
        // sollte ihr Gesamtstatus jetzt "final_abgelehnt" sein.
        expect(anfrage_B_final.Status).toBe('final_abgelehnt'); 
    });
});