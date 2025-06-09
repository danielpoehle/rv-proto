// tests/integration/analyse.test.js
const request = require('supertest');
const mongoose = require('mongoose');
const app = require('../../server');
const Slot = require('../../models/Slot');
const Kapazitaetstopf = require('../../models/Kapazitaetstopf');
const Anfrage = require('../../models/Anfrage');
const KonfliktDokumentation = require('../../models/KonfliktDokumentation');
const KonfliktGruppe = require('../../models/KonfliktGruppe');
const { parseISO, addDays } = require('date-fns');

// Annahme: Globale Konstanten und Helfer sind verfügbar
const GLOBAL_KW1_START_DATE_ISO = "2024-12-30T00:00:00.000Z";

describe('GET /api/konflikte/gruppen/:gruppenId/alternativen - Komplexe Analyse', () => {
    let konfliktGruppe = [];
    jest.setTimeout(60000);

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
        // Da das Setup sehr aufwendig ist, machen wir es einmal für die gesamte Test-Suite
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

        // ---- SETUP: Infrastruktur, Anfragen und Konflikte ----
        console.log("TEST SETUP: Erstelle Slots und Kapazitätstöpfe...");

        const commonParams = { vonPrefix: "S", bisPrefix: "E", verkehrsart: "SPFV", grundentgelt: 10 };
        const abschnitte = ["A-X", "X-B", "B-C"];
        const kws = [2, 3, 4];
        const verkehrstage = ["Mo-Fr", "Sa+So"];
        const zeiten = [
            { abf: { stunde: 9, minute: 0 }, ank: { stunde: 10, minute: 0 } }, { abf: { stunde: 9, minute: 20 }, ank: { stunde: 10, minute: 20 } }, { abf: { stunde: 9, minute: 40 }, ank: { stunde: 10, minute: 40 } },
            { abf: { stunde: 11, minute: 0 }, ank: { stunde: 12, minute: 0 } }, { abf: { stunde: 11, minute: 20 }, ank: { stunde: 12, minute: 20 } }, { abf: { stunde: 11, minute: 40 }, ank: { stunde: 12, minute: 40 } },
            { abf: { stunde: 13, minute: 0 }, ank: { stunde: 14, minute: 0 } }, { abf: { stunde: 13, minute: 20 }, ank: { stunde: 14, minute: 20 } }, { abf: { stunde: 13, minute: 40 }, ank: { stunde: 14, minute: 40 } },
            // Diese Slots bleiben als Alternativen frei
            { abf: { stunde: 15, minute: 0 }, ank: { stunde: 16, minute: 0 } }, { abf: { stunde: 15, minute: 20 }, ank: { stunde: 16, minute: 20 } }, { abf: { stunde: 15, minute: 40 }, ank: { stunde: 16, minute: 40 } }
        ];

        for (const kw of kws) {
            for (const abschnitt of abschnitte) {
                for (const vt of verkehrstage) {
                    for (const zeit of zeiten) {
                        // Erstelle 2 Slots pro "Muster", um maxKap=1 zu erhalten
                        const [von, bis] = abschnitt.split('-');
                        const slotData = { von, bis, Abschnitt: abschnitt, Kalenderwoche: kw, Verkehrstag: vt, Verkehrsart: commonParams.verkehrsart, Grundentgelt: commonParams.grundentgelt, Abfahrt: zeit.abf, Ankunft: zeit.ank };
                        await request(app).post('/api/slots').send({ ...slotData, });
                        //await new Slot(slotData).save(); // Speichere direkt für schnelleres Setup
                        //await new Slot({ ...slotData, SlotID_Sprechend: undefined }).save(); // Zweiter Slot mit gleichem Muster
                    }
                }
            }
        }

        //zusätzlich einen Slot SPNV, der von keiner Anfrage genutzt werden kann, erzeugen. Dieser Slot darf später nicht in den verfügbaren Alternativen auftauchen.
        const abschnitt = "A-X";
        const [von, bis] = abschnitt.split('-');
        const slotData = { von, bis, Abschnitt: abschnitt, Kalenderwoche: 2, Verkehrstag: "Mo-Fr", Verkehrsart: "SPNV", Grundentgelt: commonParams.grundentgelt, Abfahrt: { stunde: 9, minute: 25 }, Ankunft: { stunde: 10, minute: 55 } };
        await request(app).post('/api/slots').send({ ...slotData, });
        
        console.log("TEST SETUP: Slots erstellt.");

        // Anfragen erstellen
        const zeitraum3Wochen = { start: addDays(parseISO(GLOBAL_KW1_START_DATE_ISO), 7), ende: addDays(parseISO(GLOBAL_KW1_START_DATE_ISO), 27) }; // KW 2, 3, 4
        const a1_data = {Email: "a1@evu.de", Zugnummer: "T1", EVU: "Test", Verkehrsart: "SPFV", Verkehrstag: "täglich", Zeitraum: zeitraum3Wochen, ListeGewuenschterSlotAbschnitte: [ { von: "A", bis: "X", Abfahrtszeit: { stunde: 9, minute: 0 }, Ankunftszeit: { stunde: 10, minute: 0 } }, { von: "X", bis: "B", Abfahrtszeit: { stunde: 11, minute: 0 }, Ankunftszeit: { stunde: 12, minute: 0 } }, { von: "B", bis: "C", Abfahrtszeit: { stunde: 13, minute: 0 }, Ankunftszeit: { stunde: 14, minute: 0 } } ] };
        await request(app).post('/api/anfragen').send(a1_data);
        const a2_data = {Email: "a1@evu.de", Zugnummer: "T2", EVU: "Test", Verkehrsart: "SPFV", Verkehrstag: "täglich", Zeitraum: zeitraum3Wochen, ListeGewuenschterSlotAbschnitte: [ { von: "A", bis: "X", Abfahrtszeit: { stunde: 9, minute: 20 }, Ankunftszeit: { stunde: 10, minute: 20 } }, { von: "X", bis: "B", Abfahrtszeit: { stunde: 11, minute: 20 }, Ankunftszeit: { stunde: 12, minute: 20 } }, { von: "B", bis: "C", Abfahrtszeit: { stunde: 13, minute: 20 }, Ankunftszeit: { stunde: 14, minute: 20 } } ] };
        await request(app).post('/api/anfragen').send(a2_data);
        const a3_data = {Email: "a1@evu.de", Zugnummer: "T3", EVU: "Test", Verkehrsart: "SPFV", Verkehrstag: "täglich", Zeitraum: zeitraum3Wochen, ListeGewuenschterSlotAbschnitte: [ { von: "A", bis: "X", Abfahrtszeit: { stunde: 9, minute: 40 }, Ankunftszeit: { stunde: 10, minute: 40 } }, { von: "X", bis: "B", Abfahrtszeit: { stunde: 11, minute: 40 }, Ankunftszeit: { stunde: 12, minute: 40 } }, { von: "B", bis: "C", Abfahrtszeit: { stunde: 13, minute: 40 }, Ankunftszeit: { stunde: 14, minute: 40 } } ] };
        await request(app).post('/api/anfragen').send(a3_data);
        const a4_data = {Email: "a1@evu.de", Zugnummer: "T4", EVU: "Test", Verkehrsart: "SPFV", Verkehrstag: "Mo-Fr", Zeitraum: zeitraum3Wochen, ListeGewuenschterSlotAbschnitte: [ { von: "X", bis: "B", Abfahrtszeit: { stunde: 11, minute: 40 }, Ankunftszeit: { stunde: 12, minute: 40 } }, { von: "B", bis: "C", Abfahrtszeit: { stunde: 13, minute: 20 }, Ankunftszeit: { stunde: 14, minute: 20 } } ] };
        await request(app).post('/api/anfragen').send(a4_data);

        // 3. Zuordnungsprozess für die Anfragen anstoßen -> Erzeugt die Konfliktsituation
        let anfr = await Anfrage.find({});
        //console.log(anfr);
        for (const an of anfr) {
            an.Status = 'validiert';
            an.save(); 
            await request(app).post(`/api/anfragen/${an._id}/zuordnen`).send();            
        }        
        
        console.log("TEST SETUP: Anfragen erstellt und Konflikte simuliert. Starte Konflikterkennung");
        // Konflikterkennung und Gruppierung
        await request(app).post('/api/konflikte/identifiziere-topf-konflikte').send();
        console.log("TEST SETUP: Konflikterkennung abgeschlossen.");

        konfliktGruppe = await KonfliktGruppe.find({});
        console.log(konfliktGruppe);
    });
    
    it('sollte für eine Konfliktgruppe die korrekten, freien Alternativ-Slots für jede Anfrage zurückgeben', async () => {
        // --- VORBEREITUNG: Finde die Gruppe für den Konflikt mit allen 4 Anfragen auf Abschnitt X-B ---
        let anfragenIdsFuerGruppe = await Anfrage.find({});
        anfragenIdsFuerGruppe = anfragenIdsFuerGruppe.map(a => a._id.toString()).sort();
        const gruppenSchluessel = anfragenIdsFuerGruppe.join('#');
        const konfliktGruppe = await KonfliktGruppe.findOne({ gruppenSchluessel: gruppenSchluessel });
        expect(konfliktGruppe).not.toBeNull();

        // --- AKTION ---
        const response = await request(app)
            .get(`/api/konflikte/gruppen/${konfliktGruppe._id}/alternativen`)
            .send();

        // --- ÜBERPRÜFUNG ---
        expect(response.status).toBe(200);
        const analyseData = response.body.data;

        // Es sollte für jede der 4 Anfragen in der Gruppe ein Ergebnis geben
        expect(analyseData).toHaveLength(4);

        //console.log(analyseData);
        
        // Überprüfe das Ergebnis für die erste Anfrage (anfrage1)
        const analyseFuerAnfrage1 = analyseData.find(a => a.anfrage._id === anfragenIdsFuerGruppe[0].toString());
        expect(analyseFuerAnfrage1).toBeDefined();

        //console.log(JSON.stringify(analyseFuerAnfrage1)); 

        // Die Antwort sollte Alternativen für die KWs 2, 3 und 4 enthalten
        expect(analyseFuerAnfrage1.alternativen.map(a => a.Kalenderwoche).sort()).toEqual([2, 3, 4]);

        // Überprüfe die Struktur für KW 2
        const alternativenKW2 = analyseFuerAnfrage1.alternativen.find(a => a.Kalenderwoche === 2);
        expect(alternativenKW2).toBeDefined();

        // Die Abschnitte sollten in der Reihenfolge der Anfrage (A-X, X-B, B-C) sortiert sein
        const abschnittsReihenfolge = alternativenKW2.abschnitte.map(a => a.abschnitt);
        expect(abschnittsReihenfolge).toEqual(["A-X", "X-B", "B-C"]);

        // Überprüfe die Alternativen für den Abschnitt A-X in KW 2
        const alternativen_AX_KW2 = alternativenKW2.abschnitte.find(a => a.abschnitt === "A-X");
        expect(alternativen_AX_KW2).toBeDefined();
        const abschn_toepfe = alternativen_AX_KW2.kapazitaetstoepfe.map(a => a.topfDetails.TopfID);

        expect(abschn_toepfe).toHaveLength(3); //nur Mo-Fr 11-13,13-15,15-17, da Konflittöpfe inkl Anfrage 4 nur am Mo-Fr sind

        // Es sollte ein Kapazitätstopf für das Zeitfenster 15-17 gefunden werden
        const topf_1517 = alternativen_AX_KW2.kapazitaetstoepfe.find(t => t.topfDetails.Zeitfenster === "15-17");
        expect(topf_1517).toBeDefined();
        //console.log(topf_1517);
        
        // Dieser Topf sollte 3 freie alternative Slots enthalten (15:00, 15:20, 15:40)
        expect(topf_1517.freieSlots).toHaveLength(3);
        expect(topf_1517.freieSlots[0].Abfahrt.stunde).toBe(15);
        expect(topf_1517.freieSlots[0].Abfahrt.minute).toBe(0);
        expect(topf_1517.freieSlots[1].Abfahrt.stunde).toBe(15);
        expect(topf_1517.freieSlots[1].Abfahrt.minute).toBe(20);
        expect(topf_1517.freieSlots[2].Abfahrt.stunde).toBe(15);
        expect(topf_1517.freieSlots[2].Abfahrt.minute).toBe(40);  
        
        // Überprüfe das Ergebnis für die vierte Anfrage
        const analyseFuerAnfrage4 = analyseData.find(a => a.anfrage._id === anfragenIdsFuerGruppe[3].toString());
        expect(analyseFuerAnfrage4).toBeDefined();

        // Die Antwort sollte Alternativen für die KWs 2, 3 und 4 enthalten
        expect(analyseFuerAnfrage4.alternativen.map(a => a.Kalenderwoche).sort()).toEqual([2, 3, 4]);

        // Überprüfe die Struktur für KW 3
        const alternativenKW3 = analyseFuerAnfrage4.alternativen.find(a => a.Kalenderwoche === 3);
        expect(alternativenKW3).toBeDefined();

        // Die Abschnitte sollten in der Reihenfolge der Anfrage (X-B, B-C) sortiert sein
        const abschnittsReihenfolge4 = alternativenKW3.abschnitte.map(a => a.abschnitt);
        expect(abschnittsReihenfolge4).toEqual(["X-B", "B-C"]);

        // Überprüfe die Alternativen für den Abschnitt B-C in KW 3
        const alternativen_BC_KW3 = alternativenKW3.abschnitte.find(a => a.abschnitt === "B-C");
        expect(alternativen_BC_KW3).toBeDefined();
        const abschn_toepfe4 = alternativen_BC_KW3.kapazitaetstoepfe.map(a => a.topfDetails.TopfID);
        expect(abschn_toepfe4).toHaveLength(3); //nur Mo-Fr 9-11,11-13,15-17

        // Es sollte ein Kapazitätstopf für das Zeitfenster 11-13 gefunden werden
        const topf_1113 = alternativen_BC_KW3.kapazitaetstoepfe.find(t => t.topfDetails.Zeitfenster === "11-13");
        expect(topf_1113).toBeDefined();

        // Es sollte ein Kapazitätstopf für das Zeitfenster 09-11 gefunden werden
        const topf_0911 = alternativen_BC_KW3.kapazitaetstoepfe.find(t => t.topfDetails.Zeitfenster === "09-11");
        expect(topf_0911).toBeDefined();
        expect(topf_0911.freieSlots).toHaveLength(3);

        // Es sollte ein Kapazitätstopf für das Zeitfenster 15-17 gefunden werden
        const topf_1517_4 = alternativen_BC_KW3.kapazitaetstoepfe.find(t => t.topfDetails.Zeitfenster === "15-17");
        expect(topf_1517_4).toBeDefined();
        expect(topf_1517_4.freieSlots).toHaveLength(3);

        // Dieser Topf sollte 3 freie alternative Slots enthalten (11:00, 11:20, 11:40)
        expect(topf_1113.freieSlots).toHaveLength(3);
        expect(topf_1113.freieSlots[0].Abfahrt.stunde).toBe(11);
        expect(topf_1113.freieSlots[0].Abfahrt.minute).toBe(0);
        expect(topf_1113.freieSlots[1].Abfahrt.stunde).toBe(11);
        expect(topf_1113.freieSlots[1].Abfahrt.minute).toBe(20);
        expect(topf_1113.freieSlots[2].Abfahrt.stunde).toBe(11);
        expect(topf_1113.freieSlots[2].Abfahrt.minute).toBe(40); 
    });
});