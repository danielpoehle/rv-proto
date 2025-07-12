// tests/integration/konfliktWorkflow.test.js (Beispiel für eine neue Testdatei)
const request = require('supertest');
const mongoose = require('mongoose');
const app = require('../../server'); // Dein Express App
const Slot = require('../../models/Slot');
const Kapazitaetstopf = require('../../models/Kapazitaetstopf');
const Anfrage = require('../../models/Anfrage');
const KonfliktDokumentation = require('../../models/KonfliktDokumentation');
const KonfliktGruppe = require('../../models/KonfliktGruppe');

// Ggf. mapAbfahrtstundeToKapazitaetstopfZeitfenster importieren, falls für Topf-Erstellung benötigt
// function mapAbfahrtstundeToKapazitaetstopfZeitfenster(stunde) { /* ... */ }

describe('POST /api/konflikte/identifiziere-topf-konflikte', () => {
        let kt_DetectConflict, kt_NoConflict, kt_NoConflict2;
        let anfragenIds = [];

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

            // Vorbereitung: Kapazitätstopf mit maxKapazitaet = 2 erstellen
            const topfKriterien = {
                Abschnitt: "KonfliktZone1", Kalenderwoche: 2, Verkehrstag: "Sa+So",
                Verkehrsart: "SGV", AbfahrtStundeFuerZeitfenster: 13 // Ergibt ZF "13-15"
            };
            const topfKriterien2 = {
                Abschnitt: "KonfliktZone2", Kalenderwoche: 2, Verkehrstag: "Sa+So",
                Verkehrsart: "SGV", AbfahrtStundeFuerZeitfenster: 15 // Ergibt ZF "13-15"
            };
            const topfKriterien3 = {
                Abschnitt: "KonfliktZone3", Kalenderwoche: 2, Verkehrstag: "Sa+So",
                Verkehrsart: "SGV", AbfahrtStundeFuerZeitfenster: 13 // Ergibt ZF "13-15"
            };
            // 3 Slots für KonfliktZone1 erstellen, um maxKapazitaet = floor(0.7*3) = 2 zu erhalten
            const slotBasis = { von: "Y", bis: "Z", Abschnitt: topfKriterien.Abschnitt, Ankunft: { stunde: 14, minute: 0 }, 
                                Verkehrstag: topfKriterien.Verkehrstag, Kalenderwoche: topfKriterien.Kalenderwoche, 
                                Verkehrsart: topfKriterien.Verkehrsart,
                                Grundentgelt: 150 
                            };
            const s1 = await request(app).post('/api/slots').send({ ...slotBasis, Abfahrt: { stunde: topfKriterien.AbfahrtStundeFuerZeitfenster, minute: 10 } });
            await request(app).post('/api/slots').send({ ...slotBasis, Abfahrt: { stunde: topfKriterien.AbfahrtStundeFuerZeitfenster, minute: 20 } });
            await request(app).post('/api/slots').send({ ...slotBasis, Abfahrt: { stunde: topfKriterien.AbfahrtStundeFuerZeitfenster, minute: 30 } });
            
            // 2 Slots für KonfliktZone2 erstellen, um maxKapazitaet = floor(0.7*2) = 1 zu erhalten
            const slotBasis2 = { von: "Z", bis: "AA", Abschnitt: topfKriterien2.Abschnitt, Ankunft: { stunde: 16, minute: 0 }, 
                                Verkehrstag: topfKriterien2.Verkehrstag, Kalenderwoche: topfKriterien2.Kalenderwoche, 
                                Verkehrsart: topfKriterien2.Verkehrsart,
                                Grundentgelt: 250 
                            };
            const s2 = await request(app).post('/api/slots').send({ ...slotBasis2, Abfahrt: { stunde: topfKriterien2.AbfahrtStundeFuerZeitfenster, minute: 10 } });
            await request(app).post('/api/slots').send({ ...slotBasis2, Abfahrt: { stunde: topfKriterien2.AbfahrtStundeFuerZeitfenster, minute: 20 } });

            // 3 Slots für KonfliktZone3 erstellen, um maxKapazitaet = floor(0.7*3) = 2 zu erhalten
            const slotBasis3 = { von: "V", bis: "W", Abschnitt: topfKriterien3.Abschnitt, Ankunft: { stunde: 14, minute: 0 }, 
                                Verkehrstag: topfKriterien3.Verkehrstag, Kalenderwoche: topfKriterien3.Kalenderwoche, 
                                Verkehrsart: topfKriterien3.Verkehrsart,
                                Grundentgelt: 50 
                            };
            const s3 = await request(app).post('/api/slots').send({ ...slotBasis3, Abfahrt: { stunde: topfKriterien3.AbfahrtStundeFuerZeitfenster, minute: 10 } });
            await request(app).post('/api/slots').send({ ...slotBasis3, Abfahrt: { stunde: topfKriterien3.AbfahrtStundeFuerZeitfenster, minute: 20 } });
            await request(app).post('/api/slots').send({ ...slotBasis3, Abfahrt: { stunde: topfKriterien3.AbfahrtStundeFuerZeitfenster, minute: 30 } });
            
            
            kt_DetectConflict = await Kapazitaetstopf.findById(s1.body.data.VerweisAufTopf);
            expect(kt_DetectConflict.maxKapazitaet).toBe(2);

            kt_NoConflict = await Kapazitaetstopf.findById(s2.body.data.VerweisAufTopf);
            expect(kt_NoConflict.maxKapazitaet).toBe(1);

            kt_NoConflict2 = await Kapazitaetstopf.findById(s3.body.data.VerweisAufTopf);
            expect(kt_NoConflict2.maxKapazitaet).toBe(2);

            // 4 Anfragen erstellen für KonfliktZone1 und KonfliktZone2
            const anfrageBasis = { Email: "conflict@evu.com", Verkehrsart: "SGV", Verkehrstag: "Sa+So", Zeitraum: { start: "2025-01-06", ende: "2025-01-12" }, Status: 'validiert'}; // KW2 2025
            const anfrageBasis2 = { EVU: "ConflictEVU4", Email: "conflict@evu2.com", Verkehrsart: "SGV", Verkehrstag: "Sa+So", Zeitraum: { start: "2025-01-06", ende: "2025-01-12" }, Status: 'validiert'}; // KW2 2025
            const anfragePromises = [];
            for (let i = 1; i <= 3; i++) {
                anfragePromises.push(new Anfrage({ ...anfrageBasis, EVU: `ConflictEVU${i}` , Zugnummer: `C${i}`, ListeGewuenschterSlotAbschnitte: [{von: "Y", bis:"Z", Abfahrtszeit: {stunde:13, minute:10 + (i-1)*10 }, Ankunftszeit:{stunde:14,minute:0}}] }).save());
            }
            anfragePromises.push(new Anfrage({ ...anfrageBasis2, Zugnummer: `C4`, 
                                               ListeGewuenschterSlotAbschnitte: [{von: "Y", bis:"Z", Abfahrtszeit: {stunde:13, minute:10 }, Ankunftszeit:{stunde:14,minute:0}},
                                                                                 {von: "Z", bis:"AA", Abfahrtszeit: {stunde:15, minute:10 }, Ankunftszeit:{stunde:16,minute:0}}
                                               ] }).save());
            const erstellteAnfragen = await Promise.all(anfragePromises);
            anfragenIds = erstellteAnfragen.map(a => a._id);  
            
            // 1 Anfrage erstellen für KonfliktZone3
            let anfrage_A = await new Anfrage({ ...anfrageBasis2, EVU: "ConflictEVU5" , Zugnummer: "C5", 
                                            ListeGewuenschterSlotAbschnitte: [{von: "V", bis:"W", Abfahrtszeit: {stunde:13, minute:10 }, Ankunftszeit:{stunde:14,minute:0}}]
                                        }).save();

            // 3. Zuordnungsprozess für die Anfragen anstoßen -> Erzeugt die Konfliktsituation
            await request(app).post(`/api/anfragen/${anfragenIds[0]._id}/zuordnen`).send();
            await request(app).post(`/api/anfragen/${anfragenIds[1]._id}/zuordnen`).send();
            await request(app).post(`/api/anfragen/${anfragenIds[2]._id}/zuordnen`).send();
            await request(app).post(`/api/anfragen/${anfragenIds[3]._id}/zuordnen`).send();
            await request(app).post(`/api/anfragen/${anfrage_A._id}/zuordnen`).send();
            
            //console.log(anfrage4);

            kt_DetectConflict = await Kapazitaetstopf.findById(s1.body.data.VerweisAufTopf);
            expect(kt_DetectConflict.ListeDerAnfragen).toHaveLength(4); // Überbuchung (4 > maxKap 2)

            kt_NoConflict = await Kapazitaetstopf.findById(s2.body.data.VerweisAufTopf);
            expect(kt_NoConflict.ListeDerAnfragen).toHaveLength(1); // kein Konflikt (1 <= max Kap 1)

            kt_NoConflict2 = await Kapazitaetstopf.findById(s3.body.data.VerweisAufTopf);
            expect(kt_NoConflict2.ListeDerAnfragen).toHaveLength(1); // kein Konflikt (1 <= max Kap 2)

            // Anfragen dem Kapazitätstopf zuordnen (manuell für diesen Test)
            //kt_DetectConflict.ListeDerAnfragen = anfragenIds;
            //await kt_DetectConflict.save();
            
        });

        it('sollte einen neuen Topf-Konflikt korrekt identifizieren und den Status zugewiesenen Slots ohne Konflikt korrekt setzen', async () => {
            // Aktion: Konflikterkennung anstoßen
            const response = await request(app)
                .post('/api/konflikte/identifiziere-topf-konflikte')
                .send();

            // Überprüfung der Antwort
            expect(response.status).toBe(200);
            expect(response.body.message).toBe('Konfliktdetektion für Kapazitätstöpfe abgeschlossen.');
            expect(response.body.neuErstellteKonflikte).toHaveLength(1);
            expect(response.body.aktualisierteUndGeoeffneteKonflikte).toHaveLength(0);
            expect(response.body.unveraenderteBestehendeKonflikte).toHaveLength(0);
            expect(response.body.autoGeloesteKonflikte).toHaveLength(0);
            expect(response.body.toepfeOhneKonflikt).toHaveLength(2);

            // Anfrage C5 hat überhaupt keinen Konflikt, ist allein im Topf kt_NoConflict2 (1 <= max Kap 2)
            let anfrage5 = await Anfrage.findOne({Zugnummer: `C5`});
            expect(anfrage5.Status).toBe('vollstaendig_bestaetigt_topf');
            expect(anfrage5.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('bestaetigt_topf');

            kt_NoConflict2 = await Kapazitaetstopf.findById(kt_NoConflict2._id);
            expect(kt_NoConflict2.ListeDerAnfragen).toHaveLength(1);
            expect(kt_NoConflict2.ListeDerAnfragen[0]._id.toString()).toBe(anfrage5._id.toString());
        });

        it('sollte einen neuen Topf-Konflikt korrekt identifizieren und ein Konfliktdokument erstellen', async () => {
            // Aktion: Konflikterkennung anstoßen
            const response = await request(app)
                .post('/api/konflikte/identifiziere-topf-konflikte')
                .send();

            // Überprüfung der Antwort
            expect(response.status).toBe(200);
            expect(response.body.message).toBe('Konfliktdetektion für Kapazitätstöpfe abgeschlossen.');
            expect(response.body.neuErstellteKonflikte).toHaveLength(1);
            expect(response.body.aktualisierteUndGeoeffneteKonflikte).toHaveLength(0);
            expect(response.body.unveraenderteBestehendeKonflikte).toHaveLength(0);
            expect(response.body.autoGeloesteKonflikte).toHaveLength(0);

            const konfliktDokuId = response.body.neuErstellteKonflikte[0].id;

            // Überprüfung des erstellten Konfliktdokuments in der DB
            const konfliktDokuDB = await KonfliktDokumentation.findById(konfliktDokuId);
            expect(konfliktDokuDB).not.toBeNull();
            expect(konfliktDokuDB.ausloesenderKapazitaetstopf.toString()).toBe(kt_DetectConflict._id.toString());
            expect(konfliktDokuDB.status).toBe('offen');
            
            // Überprüfe beteiligteAnfragen (Reihenfolge nicht garantiert, daher Set-Vergleich oder Ähnliches)
            const beteiligteAnfragenStringsDB = konfliktDokuDB.beteiligteAnfragen.map(id => id.toString());
            const erwarteteAnfragenStrings = anfragenIds.map(id => id.toString());
            expect(beteiligteAnfragenStringsDB.sort()).toEqual(erwarteteAnfragenStrings.sort());
            expect(beteiligteAnfragenStringsDB).toHaveLength(4);

            //Prüfe Status der Anfragen im Konflikt
            let beteiligteAnfrage = await Anfrage.findById(beteiligteAnfragenStringsDB[0]);
            let anfrage4 = await Anfrage.findOne({Zugnummer: `C4`});
            //console.log(anfrage4);
            expect(beteiligteAnfrage.Status).toBe('in_konfliktloesung_topf');
            expect(beteiligteAnfrage.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('wartet_konflikt_topf');
            beteiligteAnfrage = await Anfrage.findById(beteiligteAnfragenStringsDB[1]);
            expect(beteiligteAnfrage.Status).toBe('in_konfliktloesung_topf');
            expect(beteiligteAnfrage.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('wartet_konflikt_topf');
            beteiligteAnfrage = await Anfrage.findById(beteiligteAnfragenStringsDB[2]);
            expect(beteiligteAnfrage.Status).toBe('in_konfliktloesung_topf');
            expect(beteiligteAnfrage.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('wartet_konflikt_topf');
            beteiligteAnfrage = await Anfrage.findById(beteiligteAnfragenStringsDB[3]);
            expect(beteiligteAnfrage.Status).toBe('in_konfliktloesung_topf');
            expect(beteiligteAnfrage.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('wartet_konflikt_topf');
            expect(anfrage4.Status).toBe('in_konfliktloesung_topf');
            expect(anfrage4.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('wartet_konflikt_topf');
            expect(anfrage4.ZugewieseneSlots[1].statusEinzelzuweisung).toBe('bestaetigt_topf');
            

            expect(konfliktDokuDB.zugewieseneAnfragen).toEqual([]);
            expect(konfliktDokuDB.abgelehnteAnfragenEntgeltvergleich).toEqual([]);
            // ... etc. für andere leere Listen
        });

        it('sollte ein existierendes offenes Topf-Konfliktdokument nicht neu erstellen, wenn sich die Anfragen nicht geändert haben', async () => {
            // 1. Erste Konflikterkennung (erstellt das Dokument)
            await request(app).post('/api/konflikte/identifiziere-topf-konflikte').send();
            let anzahlKonfliktDokus = await KonfliktDokumentation.countDocuments();
            expect(anzahlKonfliktDokus).toBe(1);
            const ersteKonfliktDoku = await KonfliktDokumentation.findOne({ ausloesenderKapazitaetstopf: kt_DetectConflict._id });

            // 2. Aktion: Konflikterkennung erneut anstoßen, ohne dass sich etwas geändert hat
            const response = await request(app)
                .post('/api/konflikte/identifiziere-topf-konflikte')
                .send();

            // Überprüfung der Antwort
            expect(response.status).toBe(200);
            expect(response.body.neuErstellteKonflikte).toHaveLength(0);
            expect(response.body.aktualisierteUndGeoeffneteKonflikte).toHaveLength(0); // Da die Anfragen gleich blieben
            expect(response.body.unveraenderteBestehendeKonflikte).toHaveLength(1);
            expect(response.body.unveraenderteBestehendeKonflikte[0].id.toString()).toBe(ersteKonfliktDoku._id.toString());


            // Überprüfung, dass keine neue Konfliktdoku erstellt wurde
            anzahlKonfliktDokus = await KonfliktDokumentation.countDocuments();
            expect(anzahlKonfliktDokus).toBe(1); // Immer noch nur eine

            const konfliktDokuDB_nachZweitemLauf = await KonfliktDokumentation.findById(ersteKonfliktDoku._id);
            expect(konfliktDokuDB_nachZweitemLauf.status).toBe('offen'); // Sollte offen geblieben sein
            // notizen könnten sich durch den zweiten Lauf geändert haben, falls wir das implementieren
        });

        it('sollte einen gelösten Topf-Konflikt zurücksetzen und wieder öffnen, wenn neue Anfragen hinzukommen und den Konflikt verändern', async () => {
            // A. Initialen Konflikt erzeugen und lösen (simuliert)
            // 1. Konflikt identifizieren (erzeugt KonfliktDoku K1)
            const identResponse1 = await request(app).post('/api/konflikte/identifiziere-topf-konflikte').send();
            expect(identResponse1.body.neuErstellteKonflikte).toHaveLength(1);
            const konfliktDokuId = identResponse1.body.neuErstellteKonflikte[0].id;

            // 2. Konflikt K1 lösen, indem 2 von 4 Anfragen verzichten (A3, A4 -> anfragenIds[2] und anfragenIds[3])
            const updatePayloadGeloest = {
                ListeAnfragenMitVerzicht: [anfragenIds[2]._id.toString(), anfragenIds[3]._id.toString()]
            };
            const loesenResponse = await request(app)
                .put(`/api/konflikte/${konfliktDokuId}/verzicht-verschub`)
                .send(updatePayloadGeloest);
            expect(loesenResponse.status).toBe(200);
            expect(loesenResponse.body.data.status).toBe('geloest');
            expect(loesenResponse.body.data.zugewieseneAnfragen).toHaveLength(2); // A1, A2 sollten zugewiesen sein

            // B. Neue Situation schaffen: Eine weitere Anfrage kommt hinzu
            anfrageNeu = await new Anfrage({ EVU: "ReopenEVU", Zugnummer: "R5", Status: 'validiert',
                Email: "reopen@evu.com", Verkehrsart: "SGV", Verkehrstag: "Sa+So", 
                Zeitraum: { start: "2025-01-06", ende: "2025-01-12" }, Entgelt: 200,
                ListeGewuenschterSlotAbschnitte: [{von: "Y", bis:"Z", Abfahrtszeit: {stunde:13, minute:20}, Ankunftszeit:{stunde:14,minute:0}}] }).save();
            //console.log(anfrageNeu);

            await request(app).post(`/api/anfragen/${anfrageNeu._id}/zuordnen`).send();            

            // C. Aktion: Konflikterkennung erneut anstoßen
            const identResponse2 = await request(app)
                .post('/api/konflikte/identifiziere-topf-konflikte')
                .send();

            // D. Überprüfung
            expect(identResponse2.status).toBe(200);
            expect(identResponse2.body.neuErstellteKonflikte).toHaveLength(0); // Kein neuer Konflikt sollte erstellt werden
            expect(identResponse2.body.aktualisierteUndGeoeffneteKonflikte).toHaveLength(1); // Der bestehende sollte aktualisiert/geöffnet werden
            expect(identResponse2.body.aktualisierteUndGeoeffneteKonflikte[0].id.toString()).toBe(konfliktDokuId.toString());

            const konfliktDoku_final = await KonfliktDokumentation.findById(konfliktDokuId);
            expect(konfliktDoku_final).not.toBeNull();
            expect(konfliktDoku_final.status).toBe('offen'); // Zurück auf 'offen'
            
            // beteiligteAnfragen sollte jetzt alle 5 Anfragen enthalten
            const erwarteteBeteiligteIds = [...anfragenIds.map(a => a._id.toString()), anfrageNeu._id.toString()];
            const tatsaechlicheBeteiligteIds = konfliktDoku_final.beteiligteAnfragen.map(id => id.toString());
            expect(tatsaechlicheBeteiligteIds.sort()).toEqual(erwarteteBeteiligteIds.sort());
            expect(tatsaechlicheBeteiligteIds).toHaveLength(5);

            let anf1 = await Anfrage.findById(erwarteteBeteiligteIds[0]);
            let anf2 = await Anfrage.findById(erwarteteBeteiligteIds[1]);
            let anf3 = await Anfrage.findById(erwarteteBeteiligteIds[2]);
            let anf4 = await Anfrage.findById(erwarteteBeteiligteIds[3]);
            let anf5 = await Anfrage.findById(erwarteteBeteiligteIds[4]);

            //console.log(anf1);

            expect(anf1.ZugewieseneSlots).not.toBeNull();
            expect(anf1.ZugewieseneSlots).toHaveLength(1);
            expect(anf1.ZugewieseneSlots[0].statusEinzelzuweisung).toEqual('wartet_konflikt_topf');
            expect(anf2.ZugewieseneSlots).not.toBeNull();
            expect(anf2.ZugewieseneSlots).toHaveLength(1);
            expect(anf2.ZugewieseneSlots[0].statusEinzelzuweisung).toEqual('wartet_konflikt_topf');
            expect(anf3.ZugewieseneSlots).not.toBeNull();
            expect(anf3.ZugewieseneSlots).toHaveLength(1);
            expect(anf3.ZugewieseneSlots[0].statusEinzelzuweisung).toEqual('wartet_konflikt_topf');
            expect(anf4.ZugewieseneSlots).not.toBeNull();
            expect(anf4.ZugewieseneSlots).toHaveLength(2);
            expect(anf4.ZugewieseneSlots[0].statusEinzelzuweisung).toEqual('wartet_konflikt_topf');
            expect(anf5.ZugewieseneSlots).not.toBeNull();
            expect(anf5.ZugewieseneSlots).toHaveLength(1);
            expect(anf5.ZugewieseneSlots[0].statusEinzelzuweisung).toEqual('wartet_konflikt_topf');

            // Resolution-Felder sollten zurückgesetzt sein
            expect(konfliktDoku_final.zugewieseneAnfragen).toEqual([]);
            expect(konfliktDoku_final.ListeAnfragenMitVerzicht).toEqual([]); // Diese werden durch den PUT /api/konflikte/:id gesetzt, nicht durch die reine Detektion
            expect(konfliktDoku_final.abschlussdatum).toBeUndefined(); // Oder null, je nach deiner Reset-Logik im Controller
            expect(konfliktDoku_final.notizen).toContain("neu bewertet/eröffnet");
        });
    });

describe('Phasenweise Konfliktlösung PUT /api/konflikte/:konfliktId/...: automatische Zuweisung bei ausreichendem Verzicht', () => {
    
    let kt_AutoResolve, anfrage1, anfrage2, anfrage3, anfrage4, konfliktDoku;
    const slotGrundentgelt = 150; // Muss in den Slots gesetzt werden für Entgeltberechnung
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
        
        // 1. Kapazitätstopf erstellen mit maxKapazitaet = 2
            const topfKriterien = {
                Abschnitt: "AutoResolveZone", Kalenderwoche: 1, Verkehrstag: "Mo-Fr",
                Verkehrsart: "SPFV", AbfahrtStundeFuerZeitfenster: 8 // Ergibt ZF "07-09"
            };
            const slotBasis = { 
                von: "X", bis: "Y", Abschnitt: topfKriterien.Abschnitt, 
                Ankunft: { stunde: 9, minute: 0 }, 
                Verkehrstag: topfKriterien.Verkehrstag, 
                Kalenderwoche: topfKriterien.Kalenderwoche, 
                Verkehrsart: topfKriterien.Verkehrsart, 
                Grundentgelt: slotGrundentgelt // Grundentgelt für Entgeltberechnung
            };
            
            // Erstelle 3 Slots, die alle denselben Topf (KT_AutoResolve) verwenden/erzeugen
            const s1Resp = await request(app).post('/api/slots').send({ ...slotBasis, Abfahrt: { stunde: topfKriterien.AbfahrtStundeFuerZeitfenster, minute: 10 } });
            const s2Resp = await request(app).post('/api/slots').send({ ...slotBasis, Abfahrt: { stunde: topfKriterien.AbfahrtStundeFuerZeitfenster, minute: 20 } });
            const s3Resp = await request(app).post('/api/slots').send({ ...slotBasis, Abfahrt: { stunde: topfKriterien.AbfahrtStundeFuerZeitfenster, minute: 30 } });
            
            const verweisAufTopfId = s1Resp.body.data.VerweisAufTopf;
            kt_AutoResolve = await Kapazitaetstopf.findById(verweisAufTopfId);
            expect(kt_AutoResolve.ListeDerSlots).toHaveLength(3);
            expect(kt_AutoResolve.maxKapazitaet).toBe(Math.floor(0.7 * 3)); // = 2

            // 2. Anfragen erstellen (mit initialen ZugewieseneSlots für Entgeltberechnung)
            //    Die Entgelte werden hier im Test manuell gesetzt, um den Fokus auf die Konfliktlösung zu legen.
            //    In einem echten Szenario wären sie durch den Zuordnungsprozess berechnet worden.
            const anfrageBasis = { 
                 Email: "test@evu.com", Verkehrsart: "SPFV", Verkehrstag: "Mo-Fr", 
                Zeitraum: { start: "2024-12-30", ende: "2025-01-05" }, // 1 Woche Mo-Fr = 5 Tage
                ListeGewuenschterSlotAbschnitte: [{von: "X", bis:"Y", Abfahrtszeit: {stunde:8, minute:0}, Ankunftszeit:{stunde:9,minute:0}}],
                // Simuliere, dass Slots initial zugewiesen wurden und einen Status haben
                ZugewieseneSlots: [
                    { slot: s1Resp.body.data._id, statusEinzelzuweisung: 'initial_in_konfliktpruefung_topf'},
                    // Für Einfachheit nehmen wir an, jede Anfrage bezieht sich auf einen der erstellten Slots.
                    // In Realität würden sie sich ggf. die gleichen Slots teilen.
                ]
            };
            
            anfrage1 = await new Anfrage({ ...anfrageBasis, EVU: "TestEVU1", Zugnummer: "A1", Entgelt: 5 * slotGrundentgelt, Status: 'in_konfliktloesung_topf' }).save();
            anfrage2 = await new Anfrage({ ...anfrageBasis, EVU: "TestEVU2", Zugnummer: "A2", Entgelt: 5 * slotGrundentgelt, Status: 'in_konfliktloesung_topf', ZugewieseneSlots: [{ slot: s2Resp.body.data._id, statusEinzelzuweisung: 'initial_in_konfliktpruefung_topf'}] }).save();
            anfrage3 = await new Anfrage({ ...anfrageBasis, EVU: "TestEVU3", Zugnummer: "A3", Entgelt: 5 * slotGrundentgelt, Status: 'in_konfliktloesung_topf', ZugewieseneSlots: [{ slot: s3Resp.body.data._id, statusEinzelzuweisung: 'initial_in_konfliktpruefung_topf'}] }).save();
            

            // Vereinfachtes Setup für diesen Test: Wir fokussieren auf die Konfliktlösung, nicht die Zuordnung.
            // Annahme: Zuordnung hat stattgefunden, Topf ist überbucht.
            kt_AutoResolve.ListeDerAnfragen = [anfrage1._id, anfrage2._id, anfrage3._id]; // 3 Anfragen für maxKap 2
            await kt_AutoResolve.save();
            expect(kt_AutoResolve.ListeDerAnfragen).toHaveLength(3);

            // 3. Konfliktdokument erstellen
            konfliktDoku = await new KonfliktDokumentation({
                konfliktTyp: 'KAPAZITAETSTOPF',
                beteiligteAnfragen: [anfrage1._id, anfrage2._id, anfrage3._id],
                ausloesenderKapazitaetstopf: kt_AutoResolve._id,
                status: 'offen',
                notizen: "Initialer Konflikt für Verzicht-Test"
            }).save();
    });

    it('sollte Anfragen automatisch zuweisen und Topf-Konflikt lösen, wenn nach Verzicht die Kapazität ausreicht', async () => {
        // Aktion: Eine Anfrage (anfrage3) verzichtet. maxKap = 2. Verbleiben 2 Anfragen.
            const updatePayload = {
                ListeAnfragenMitVerzicht: [anfrage3._id.toString()],
            };

            const response = await request(app)
                .put(`/api/konflikte/${konfliktDoku._id}/verzicht-verschub`) // Neuer Endpunkt
                .send(updatePayload);

            expect(response.status).toBe(200);
            const aktualisierteKonfliktDoku = response.body.data;

            // Überprüfung des Konfliktdokuments
            expect(aktualisierteKonfliktDoku.status).toBe('geloest');
            expect(aktualisierteKonfliktDoku.ListeAnfragenMitVerzicht.map(id => id.toString())).toEqual([anfrage3._id.toString()]);
            
            const zugewieseneIdsKonflikt = aktualisierteKonfliktDoku.zugewieseneAnfragen.map(id => id.toString());
            expect(zugewieseneIdsKonflikt).toHaveLength(2);
            expect(zugewieseneIdsKonflikt).toContain(anfrage1._id.toString());
            expect(zugewieseneIdsKonflikt).toContain(anfrage2._id.toString());
            expect(aktualisierteKonfliktDoku.abschlussdatum).toBeDefined();

            // Überprüfung der Anfragen-Status und Einzelzuweisungen
            const a1_updated = await Anfrage.findById(anfrage1._id).populate('ZugewieseneSlots.slot');
            const a2_updated = await Anfrage.findById(anfrage2._id).populate('ZugewieseneSlots.slot');
            const a3_updated = await Anfrage.findById(anfrage3._id).populate('ZugewieseneSlots.slot');
            // console.log(a1_updated);

            // Für A1 und A2: statusEinzelzuweisung der relevanten Slots sollte 'bestaetigt_topf' sein
            a1_updated.ZugewieseneSlots.forEach(zs => {
                if (zs.slot.VerweisAufTopf.equals(kt_AutoResolve._id)) {
                    expect(zs.statusEinzelzuweisung).toBe('bestaetigt_topf');
                }
            });
            expect(a1_updated.Status).toBe('vollstaendig_bestaetigt_topf'); // Annahme: updateGesamtStatus setzt dies korrekt

            a2_updated.ZugewieseneSlots.forEach(zs => {
                if (zs.slot.VerweisAufTopf.equals(kt_AutoResolve._id)) {
                    expect(zs.statusEinzelzuweisung).toBe('bestaetigt_topf');
                }
            });
            expect(a2_updated.Status).toBe('vollstaendig_bestaetigt_topf');

            // Für A3: statusEinzelzuweisung der relevanten Slots sollte 'abgelehnt_topf_verzichtet' sein
            a3_updated.ZugewieseneSlots.forEach(zs => {
                if (zs.slot.VerweisAufTopf.equals(kt_AutoResolve._id)) {
                    expect(zs.statusEinzelzuweisung).toBe('abgelehnt_topf_verzichtet');
                }
            });
            // Der Gesamtstatus von A3 hängt davon ab, ob es noch andere, nicht betroffene Slot-Zuweisungen hat.
            // Wenn dies die einzigen Slots waren, sollte der Gesamtstatus 'final_abgelehnt' oder ähnlich sein.
            // Für diesen Test fokussieren wir auf die Einzelzuweisung.
            // Die updateGesamtStatus-Methode muss diese Logik korrekt abbilden.
            // Nehmen wir an, nach Verzicht für diesen Topf ist die Anfrage effektiv raus:
             expect(a3_updated.Status).toMatch(/final_abgelehnt|storniert_system/);

    });

    it('sollte eine komplette Konfliktgruppe zurücksetzen, Konfliktdokus löschen und Anfragen-Status revertieren', async () => {
        // ---- SETUP: Erzeuge einen Konflikt mit 3 Anfragen für maxKapazität=2 ----
        const topfKriterien = { Abschnitt: "ResetZone", Kalenderwoche: 1, Verkehrstag: "Mo-Fr", Verkehrsart: "SPFV", AbfahrtStundeFuerZeitfenster: 8 };
        const slotBasis = { von: "R", bis: "S", Abschnitt: topfKriterien.Abschnitt, Ankunft: { stunde: 9, minute: 0 }, Verkehrstag: topfKriterien.Verkehrstag, Kalenderwoche: topfKriterien.Kalenderwoche, Verkehrsart: topfKriterien.Verkehrsart, Grundentgelt: 100 };
        // Erstelle 3 Slots -> maxKap = 2
        const s1Resp = await request(app).post('/api/slots').send({ ...slotBasis, Abfahrt: { stunde: 8, minute: 10 } });
        await request(app).post('/api/slots').send({ ...slotBasis, Abfahrt: { stunde: 8, minute: 20 } });
        const s3Resp = await request(app).post('/api/slots').send({ ...slotBasis, Abfahrt: { stunde: 8, minute: 30 } });
        const kt_Reset = await Kapazitaetstopf.findById(s1Resp.body.data.VerweisAufTopf);
        expect(kt_Reset.maxKapazitaet).toBe(2);

        // Erstelle 3 Anfragen
        const zugewieseneSlotsFuerAnfragen = (await Slot.find({ VerweisAufTopf: kt_Reset._id })).map(s => ({
            slot: s._id,
            statusEinzelzuweisung: 'initial_in_konfliktpruefung_topf'
        }));
        const anfrageBasis = { Email: "reset@evu.com", Verkehrsart: "SPFV", Verkehrstag: "Mo-Fr", Zeitraum: { start: "2024-12-30", ende: "2025-01-05" }, ListeGewuenschterSlotAbschnitte: [{von: "R", bis:"S", Abfahrtszeit: {stunde:8, minute:0}, Ankunftszeit:{stunde:9,minute:0}}], ZugewieseneSlots: zugewieseneSlotsFuerAnfragen };
        
        let anfrage1 = await new Anfrage({ ...anfrageBasis, EVU: "ResetEVU1", Zugnummer: "R1", Entgelt: 500, Status: 'in_konfliktloesung_topf' }).save();
        let anfrage2 = await new Anfrage({ ...anfrageBasis, EVU: "ResetEVU2", Zugnummer: "R2", Entgelt: 500, Status: 'in_konfliktloesung_topf' }).save();
        let anfrage3 = await new Anfrage({ ...anfrageBasis, EVU: "ResetEVU3", Zugnummer: "R3", Entgelt: 500, Status: 'in_konfliktloesung_topf' }).save();
        
        kt_Reset.ListeDerAnfragen = [anfrage1._id, anfrage2._id, anfrage3._id]; // 3 Anfragen -> Konflikt
        await kt_Reset.save();

        // Identifiziere Konflikt und Gruppe
        await request(app).post('/api/konflikte/identifiziere-topf-konflikte').send();
        const konfliktGruppe = await KonfliktGruppe.findOne({ "beteiligteAnfragen": anfrage1._id });
        expect(konfliktGruppe).not.toBeNull();
        expect(konfliktGruppe.konflikteInGruppe).toHaveLength(1);
        
        // ---- SIMULIERE LÖSUNG: Löse den Konflikt, indem Anfrage 3 verzichtet ----
        const updatePayload = {
            konfliktDokumentIds: konfliktGruppe.konflikteInGruppe,
            ListeAnfragenMitVerzicht: [anfrage3._id.toString()]
        };
        const loesenResponse = await request(app)
            .put(`/api/konflikte/gruppen/${konfliktGruppe._id}/verzicht-verschub`)
            .send(updatePayload);
        expect(loesenResponse.status).toBe(200);
        expect(loesenResponse.body.data.gruppe.status).toBe('vollstaendig_geloest');

        //console.log(loesenResponse.body.data.gruppe.konflikteInGruppe[0]);

        anfrage1 = await Anfrage.findById(anfrage1._id);
        anfrage2 = await Anfrage.findById(anfrage2._id);
        anfrage3 = await Anfrage.findById(anfrage3._id);

        //console.log(anfrage3);

        expect(anfrage1.Status).toBe('vollstaendig_bestaetigt_topf');
        expect(anfrage2.Status).toBe('vollstaendig_bestaetigt_topf');
        expect(anfrage3.Status).toBe('final_abgelehnt');

        // ---- AKTION: Rufe den Reset-Endpunkt für die Gruppe auf ----
        const resetResponse = await request(app)
            .post(`/api/konflikte/gruppen/${konfliktGruppe._id}/reset`)
            .send();

        // ---- ÜBERPRÜFUNG ----
        // 1. Überprüfung der Reset-Antwort
        expect(resetResponse.status).toBe(200);
        expect(resetResponse.body.message).toBe('Konfliktgruppe erfolgreich zurückgesetzt.');
        expect(resetResponse.body.summary.anfragenZurueckgesetzt).toBe(3);
        expect(resetResponse.body.summary.konfliktDokusGeloescht).toBe(1);

        // 2. Überprüfung der Datenbank: Konflikt-Objekte sollten gelöscht sein
        const geloeschteGruppe = await KonfliktGruppe.findById(konfliktGruppe._id);
        expect(geloeschteGruppe).toBeNull();
        
        const anzahlKonfliktDokus = await KonfliktDokumentation.countDocuments({ 
            _id: { $in: konfliktGruppe.konflikteInGruppe } 
        });
        expect(anzahlKonfliktDokus).toBe(0);

        // 3. Überprüfung der Anfragen: Status sollten zurückgesetzt sein
        const anfrage1_final = await Anfrage.findById(anfrage1._id);
        const anfrage2_final = await Anfrage.findById(anfrage2._id);
        const anfrage3_final = await Anfrage.findById(anfrage3._id);

        // Prüfe den Gesamtstatus, der durch updateGesamtStatus() neu berechnet wurde
        expect(anfrage1_final.Status).toBe('in_konfliktpruefung');
        expect(anfrage2_final.Status).toBe('in_konfliktpruefung');
        expect(anfrage3_final.Status).toBe('in_konfliktpruefung');

        // Prüfe den granularen Status der Slot-Zuweisung
        // Anfrage 1 und 2 waren 'bestaetigt_topf', Anfrage 3 war 'abgelehnt_topf_verzichtet'
        // -> Alle sollten jetzt wieder 'initial_in_konfliktpruefung_topf' sein.
        for(const zuweisung of anfrage1_final.ZugewieseneSlots) {
            expect(zuweisung.statusEinzelzuweisung).toBe('initial_in_konfliktpruefung_topf');
        }
        for(const zuweisung of anfrage2_final.ZugewieseneSlots) {
            expect(zuweisung.statusEinzelzuweisung).toBe('initial_in_konfliktpruefung_topf');
        }
        for(const zuweisung of anfrage3_final.ZugewieseneSlots) {
            expect(zuweisung.statusEinzelzuweisung).toBe('initial_in_konfliktpruefung_topf');
        }
    });

    // Weitere Testfälle für updateKonflikt (z.B. wenn Kapazität nicht ausreicht, Entgeltphase etc.)
});

describe('PUT /api/konflikte/:konfliktId - Konfliktlösung Workflow: Durchführung Entgeltvergleich und Erkennung Höchstpreisverfahren', () => {
        let kt_EntgeltTest;
        let anfrageHoch, anfrageMittel, anfrageNiedrig;
        let konfliktDoku;
        const slotGrundentgelt = 100; // Ein Beispiel-Grundentgelt für die Slots

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
            // 1. Kapazitätstopf mit maxKapazitaet = 1 erstellen
            const topfKriterien = { Abschnitt: "EntgeltVglZone", Kalenderwoche: 4, Verkehrstag: "Mo-Fr", Verkehrsart: "SPFV", AbfahrtStundeFuerZeitfenster: 8 };
            const slotBasis = { von: "E1", bis: "E2", Abschnitt: topfKriterien.Abschnitt, Ankunft: { stunde: 9, minute: 0 }, Verkehrstag: topfKriterien.Verkehrstag, Kalenderwoche: topfKriterien.Kalenderwoche, Verkehrsart: topfKriterien.Verkehrsart, Grundentgelt: slotGrundentgelt };
            // Erstelle 2 Slots, um maxKapazitaet = floor(0.7*2) = 1 zu erhalten
            const s1Resp = await request(app).post('/api/slots').send({ ...slotBasis, Abfahrt: { stunde: topfKriterien.AbfahrtStundeFuerZeitfenster, minute: 10 } });
            await request(app).post('/api/slots').send({ ...slotBasis, Abfahrt: { stunde: topfKriterien.AbfahrtStundeFuerZeitfenster, minute: 20 } });
            kt_EntgeltTest = await Kapazitaetstopf.findById(s1Resp.body.data.VerweisAufTopf);
            expect(kt_EntgeltTest.maxKapazitaet).toBe(1);

            // 2. Anfragen mit unterschiedlichen (vorberechneten) Entgelten erstellen
            // Annahme: Jede Anfrage nutzt einen Weg, der Kosten von `slotGrundentgelt` pro Tag verursacht.
            // Anfrage Hoch: 10 Tage -> Entgelt 1000
            const zeitraumHoch = { start: "2025-01-20", ende: "2025-01-31" }; // 2 Wochen Mo-Fr = 10 Tage
            const tageHoch = 10; 
            anfrageHoch = await new Anfrage({ Zugnummer: "EHoch", EVU: "EVU1", ListeGewuenschterSlotAbschnitte: [{ von: "E1", bis: "E2", Abfahrtszeit: { stunde: 8, minute: 10 }, Ankunftszeit: { stunde: 9, minute: 0 } }], Verkehrsart: "SPFV", Verkehrstag: "Mo-Fr", Zeitraum: zeitraumHoch, Email: "hoch@evu.com", Status: "in_konfliktloesung_topf", Entgelt: tageHoch * slotGrundentgelt, ZugewieseneSlots: [{slot: s1Resp.body.data._id, statusEinzelzuweisung: 'initial_in_konfliktpruefung_topf'}] }).save();
            
            // Anfrage Mittel: 7 Tage -> Entgelt 700
            const zeitraumMittel = { start: "2025-01-20", ende: "2025-01-28" }; // 7 Tage Mo-Fr
            const tageMittel = 7;
            anfrageMittel = await new Anfrage({ Zugnummer: "EMittel", EVU: "EVU2", ListeGewuenschterSlotAbschnitte: [{ von: "E1", bis: "E2", Abfahrtszeit: { stunde: 8, minute: 10 }, Ankunftszeit: { stunde: 9, minute: 0 } }], Verkehrsart: "SPFV", Verkehrstag: "Mo-Fr", Zeitraum: zeitraumMittel, Email: "mittel@evu.com", Status: "in_konfliktloesung_topf", Entgelt: tageMittel * slotGrundentgelt, ZugewieseneSlots: [{slot: s1Resp.body.data._id, statusEinzelzuweisung: 'initial_in_konfliktpruefung_topf'}] }).save();

            // Anfrage Niedrig: 5 Tage -> Entgelt 500
            const zeitraumNiedrig = { start: "2025-01-20", ende: "2025-01-24" }; // 1 Woche Mo-Fr = 5 Tage
            const tageNiedrig = 5;
            anfrageNiedrig = await new Anfrage({ Zugnummer: "ENiedrig", EVU: "EVU3", ListeGewuenschterSlotAbschnitte: [{ von: "E1", bis: "E2", Abfahrtszeit: { stunde: 8, minute: 10 }, Ankunftszeit: { stunde: 9, minute: 0 } }], Verkehrsart: "SPFV", Verkehrstag: "Mo-Fr", Zeitraum: zeitraumNiedrig, Email: "niedrig@evu.com", Status: "in_konfliktloesung_topf", Entgelt: tageNiedrig * slotGrundentgelt, ZugewieseneSlots: [{slot: s1Resp.body.data._id, statusEinzelzuweisung: 'initial_in_konfliktpruefung_topf'}] }).save();

            // Anfragen dem Kapazitätstopf zuordnen
            kt_EntgeltTest.ListeDerAnfragen = [anfrageHoch._id, anfrageMittel._id, anfrageNiedrig._id];
            await kt_EntgeltTest.save(); // 3 Anfragen > maxKap 1 -> Konflikt

            // Konfliktdokument erstellen (simuliert /api/konflikte/identifiziere-topf-konflikte)
            konfliktDoku = await new KonfliktDokumentation({
                konfliktTyp: 'KAPAZITAETSTOPF',
                beteiligteAnfragen: [anfrageHoch._id, anfrageMittel._id, anfrageNiedrig._id],
                ausloesenderKapazitaetstopf: kt_EntgeltTest._id,
                status: 'offen' // Startet als 'offen'
            }).save();
        });

        // NEUER TESTFALL für Entgeltvergleich, eindeutige Entscheidung.
        it('sollte Konflikt durch Entgeltvergleich lösen, ReihungEntgelt auto-generieren und Anfragen korrekt zuweisen/ablehnen (granularer Status)', async () => {
            // ---- SETUP: Erzeuge einen Konflikt mit 3 Anfragen für maxKapazität=1 ----
            let kt_Entgelt, anfrageHoch, anfrageMittel, anfrageNiedrig, konfliktDoku;
            const slotGrundentgelt = 100;

            // 1. Kapazitätstopf mit maxKapazitaet = 1
            const topfKriterien = { Abschnitt: "EntgeltZone2", Kalenderwoche: 4, Verkehrstag: "Mo-Fr", Verkehrsart: "SPFV", AbfahrtStundeFuerZeitfenster: 8 };
            const slotBasis = { von: "E11", bis: "E21", Abschnitt: topfKriterien.Abschnitt, Ankunft: { stunde: 9, minute: 0 }, Verkehrstag: topfKriterien.Verkehrstag, Kalenderwoche: topfKriterien.Kalenderwoche, Verkehrsart: topfKriterien.Verkehrsart, Grundentgelt: slotGrundentgelt };
            const s1Resp = await request(app).post('/api/slots').send({ ...slotBasis, Abfahrt: { stunde: topfKriterien.AbfahrtStundeFuerZeitfenster, minute: 10 } });
            await request(app).post('/api/slots').send({ ...slotBasis, Abfahrt: { stunde: topfKriterien.AbfahrtStundeFuerZeitfenster, minute: 20 } });
            kt_Entgelt = await Kapazitaetstopf.findById(s1Resp.body.data.VerweisAufTopf);
            expect(kt_Entgelt.maxKapazitaet).toBe(1); // floor(0.7 * 2) = 1
            

            // 2. Anfragen erstellen mit vorbefülltem Entgelt und initial zugewiesenen Slots
            const anfrageBasis = { Email: "entgelt@evu.com", Verkehrsart: "SPFV", Verkehrstag: "Mo-Fr", ListeGewuenschterSlotAbschnitte: [{von: "E1", bis:"E2", Abfahrtszeit: {stunde:8, minute:0}, Ankunftszeit:{stunde:9,minute:0}}], ZugewieseneSlots: [{ slot: s1Resp.body.data._id, statusEinzelzuweisung: 'initial_in_konfliktpruefung_topf'}] };
            
            const zeitraumHoch = { start: "2025-01-20", ende: "2025-01-31" }; // 10 Tage
            anfrageHoch = await new Anfrage({ ...anfrageBasis, EVU: "EntgeltEVU1",  Zugnummer: "Hoch", Zeitraum: zeitraumHoch, Entgelt: 10 * slotGrundentgelt, Status: "in_konfliktloesung_topf" }).save();
            const zeitraumMittel = { start: "2025-01-20", ende: "2025-01-28" }; // 7 Tage
            anfrageMittel = await new Anfrage({ ...anfrageBasis, EVU: "EntgeltEVU2",  Zugnummer: "Mittel", Zeitraum: zeitraumMittel, Entgelt: 7 * slotGrundentgelt, Status: "in_konfliktloesung_topf" }).save();
            const zeitraumNiedrig = { start: "2025-01-20", ende: "2025-01-24" }; // 5 Tage
            anfrageNiedrig = await new Anfrage({ ...anfrageBasis, EVU: "EntgeltEVU3",  Zugnummer: "Niedrig", Zeitraum: zeitraumNiedrig, Entgelt: 5 * slotGrundentgelt, Status: "in_konfliktloesung_topf" }).save();

            kt_Entgelt.ListeDerAnfragen = [anfrageHoch._id, anfrageMittel._id, anfrageNiedrig._id];
            await kt_Entgelt.save();

            // 3. Konfliktdokument erstellen
            konfliktDoku = await new KonfliktDokumentation({
                konfliktTyp: 'KAPAZITAETSTOPF',
                beteiligteAnfragen: [anfrageHoch._id, anfrageMittel._id, anfrageNiedrig._id],
                ausloesenderKapazitaetstopf: kt_Entgelt._id,
                status: 'in_bearbeitung_entgelt' // Status, nachdem Verzicht/Verschub nicht zur Lösung führte
            }).save();
            
            // ---- AKTION: Entgeltvergleich anstoßen ----
            const response = await request(app)
                .put(`/api/konflikte/${konfliktDoku._id}/entgeltvergleich`) // Neuer Endpunkt
                .send(); // Kein Body nötig, Aktion wird durch Endpunkt impliziert

            // ---- ÜBERPRÜFUNG ----
            // 1. Überprüfung des Konfliktdokuments
            expect(response.status).toBe(200);
            const aktualisierteKonfliktDoku = response.body.data;
            expect(aktualisierteKonfliktDoku.status).toBe('geloest');
            expect(aktualisierteKonfliktDoku.abschlussdatum).toBeDefined();

            //console.log(aktualisierteKonfliktDoku);

            // ReihungEntgelt
            expect(aktualisierteKonfliktDoku.ReihungEntgelt).toHaveLength(3);
            expect(aktualisierteKonfliktDoku.ReihungEntgelt[0].anfrage._id.toString()).toBe(anfrageHoch._id.toString());
            expect(aktualisierteKonfliktDoku.ReihungEntgelt[0].entgelt).toBe(1000);
            
            // Zugewiesene/Abgelehnte Anfragen im Konfliktdokument
            expect(aktualisierteKonfliktDoku.zugewieseneAnfragen).toHaveLength(1);
            expect(aktualisierteKonfliktDoku.zugewieseneAnfragen[0].toString()).toBe(anfrageHoch._id.toString());
            const abgelehnteIds = aktualisierteKonfliktDoku.abgelehnteAnfragenEntgeltvergleich.map(id => id.toString());
            expect(abgelehnteIds).toHaveLength(2);
            expect(abgelehnteIds).toContain(anfrageMittel._id.toString());
            expect(abgelehnteIds).toContain(anfrageNiedrig._id.toString());

            // 2. Überprüfung der Anfragen-Status (Gesamt und Einzelzuweisung)
            const aHoch_final = await Anfrage.findById(anfrageHoch._id);
            const aMittel_final = await Anfrage.findById(anfrageMittel._id);
            const aNiedrig_final = await Anfrage.findById(anfrageNiedrig._id);

            // ANFRAGE HOCH (Gewinner)
            // Die Einzelzuweisung für den Slot in diesem Topf sollte 'bestaetigt_topf_entgelt' sein
            expect(aHoch_final.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('bestaetigt_topf_entgelt');
            // Der Gesamtstatus sollte dies widerspiegeln (z.B. 'vollstaendig_bestaetigt_topf', bis Slot-Konflikte kommen)
            expect(aHoch_final.Status).toBe('vollstaendig_bestaetigt_topf');

            // ANFRAGE MITTEL (Verlierer)
            expect(aMittel_final.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('abgelehnt_topf_entgelt');
            // Der Gesamtstatus sollte eine Ablehnung widerspiegeln (da es die einzige Zuweisung war)
            expect(aMittel_final.Status).toBe('final_abgelehnt');

            // ANFRAGE NIEDRIG (Verlierer)
            expect(aNiedrig_final.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('abgelehnt_topf_entgelt');
            expect(aNiedrig_final.Status).toBe('final_abgelehnt');
        });

        // TESTFALL für Gleichstand beim Entgelt
        it('sollte bei Gleichstand im Entgeltvergleich korrekt in den Höchstpreis-Status wechseln und Anfragen-Status granular aktualisieren', async () => {
            // ---- SETUP: Erzeuge einen Konflikt, der zu einem Gleichstand führen wird ----
            let kt_TieBreak, anfrageA1, anfrageA2, anfrageA3, anfrageA4;
            let konfliktDokuTie;
            const slotGrundentgelt = 100;

            // 1. Kapazitätstopf mit maxKapazitaet = 2
            const topfKriterienTie = { Abschnitt: "TieZone", Kalenderwoche: 5, Verkehrstag: "Mo-Fr", Verkehrsart: "SGV", AbfahrtStundeFuerZeitfenster: 9 };
            const slotBasisTie = { von: "T1", bis: "T2", Abschnitt: topfKriterienTie.Abschnitt, Ankunft: { stunde: 10, minute: 0 }, Verkehrstag: topfKriterienTie.Verkehrstag, Kalenderwoche: topfKriterienTie.Kalenderwoche, Verkehrsart: topfKriterienTie.Verkehrsart, Grundentgelt: slotGrundentgelt };
            
            const sT1Resp = await request(app).post('/api/slots').send({ ...slotBasisTie, Abfahrt: { stunde: topfKriterienTie.AbfahrtStundeFuerZeitfenster, minute: 10 } });
            await request(app).post('/api/slots').send({ ...slotBasisTie, Abfahrt: { stunde: topfKriterienTie.AbfahrtStundeFuerZeitfenster, minute: 20 } });
            await request(app).post('/api/slots').send({ ...slotBasisTie, Abfahrt: { stunde: topfKriterienTie.AbfahrtStundeFuerZeitfenster, minute: 30 } });
            kt_TieBreak = await Kapazitaetstopf.findById(sT1Resp.body.data.VerweisAufTopf);
            expect(kt_TieBreak.maxKapazitaet).toBe(2);

            // 2. Anfragen mit Entgelten erstellen, die zu Gleichstand führen
            const anfrageBasisTie = { Email: "tie@evu.com", Verkehrsart: "SGV", Verkehrstag: "Mo-Fr", ListeGewuenschterSlotAbschnitte: [{von: "T1", bis:"T2", Abfahrtszeit: {stunde:9, minute:0}, Ankunftszeit:{stunde:10,minute:0}}], ZugewieseneSlots: [{ slot: sT1Resp.body.data._id, statusEinzelzuweisung: 'initial_in_konfliktpruefung_topf' }] };

            const zeitraumA1 = { start: "2025-02-03", ende: "2025-02-14" }; // 10 Tage -> Entgelt 1000
            anfrageA1 = await new Anfrage({ ...anfrageBasisTie, EVU: "TieEVU1", Zugnummer: "TA1", Zeitraum: zeitraumA1, Entgelt: 10 * slotGrundentgelt, Status: "in_konfliktloesung_topf" }).save();

            const zeitraumA2_A3 = { start: "2025-02-03", ende: "2025-02-13" }; // 9 Tage -> Entgelt 900
            anfrageA2 = await new Anfrage({ ...anfrageBasisTie, EVU: "TieEVU2", Zugnummer: "TA2", Zeitraum: zeitraumA2_A3, Entgelt: 9 * slotGrundentgelt, Status: "in_konfliktloesung_topf" }).save();
            anfrageA3 = await new Anfrage({ ...anfrageBasisTie, EVU: "TieEVU3", Zugnummer: "TA3", Zeitraum: zeitraumA2_A3, Entgelt: 9 * slotGrundentgelt, Status: "in_konfliktloesung_topf" }).save();

            const zeitraumA4 = { start: "2025-02-03", ende: "2025-02-11" }; // 7 Tage -> Entgelt 700
            anfrageA4 = await new Anfrage({ ...anfrageBasisTie, EVU: "TieEVU4", Zugnummer: "TA4", Zeitraum: zeitraumA4, Entgelt: 7 * slotGrundentgelt, Status: "in_konfliktloesung_topf" }).save();
            
            // 3. Konfliktdokument erstellen
            kt_TieBreak.ListeDerAnfragen = [anfrageA1._id, anfrageA2._id, anfrageA3._id, anfrageA4._id];
            await kt_TieBreak.save();
            
            konfliktDokuTie = await new KonfliktDokumentation({
                konfliktTyp: 'KAPAZITAETSTOPF',
                beteiligteAnfragen: [anfrageA1._id, anfrageA2._id, anfrageA3._id, anfrageA4._id],
                ausloesenderKapazitaetstopf: kt_TieBreak._id,
                status: 'in_bearbeitung_entgelt' // Simuliere Status nach Verzicht/Verschub
            }).save();
            
            // ---- AKTION: Entgeltvergleich anstoßen ----
            const response = await request(app)
                .put(`/api/konflikte/${konfliktDokuTie._id}/entgeltvergleich`) // Neuer Endpunkt
                .send({}); // Kein Body nötig

            // ---- ÜBERPRÜFUNG ----
            // 1. Überprüfung der Antwort und des Konfliktdokuments
            expect(response.status).toBe(200);
            const aktualisierteKonfliktDoku = response.body.data;
            //console.log(aktualisierteKonfliktDoku);

            expect(aktualisierteKonfliktDoku.status).toBe('in_bearbeitung_hoechstpreis'); // Korrekter Übergangsstatus
            expect(aktualisierteKonfliktDoku.ReihungEntgelt).toHaveLength(4);
            // A1 ist zugewiesen, da höchstes Entgelt
            expect(aktualisierteKonfliktDoku.zugewieseneAnfragen).toHaveLength(1);
            expect(aktualisierteKonfliktDoku.zugewieseneAnfragen[0].toString()).toBe(anfrageA1._id.toString());
            // A4 ist abgelehnt, da niedrigstes Entgelt
            expect(aktualisierteKonfliktDoku.abgelehnteAnfragenEntgeltvergleich).toHaveLength(1);
            expect(aktualisierteKonfliktDoku.abgelehnteAnfragenEntgeltvergleich[0].toString()).toBe(anfrageA4._id.toString());
            expect(aktualisierteKonfliktDoku.notizen).toContain("Höchstpreisverfahren für 2 Anfragen eingeleitet");

            // 2. Überprüfung der Anfragen-Status (Gesamt und Einzelzuweisung)
            const a1_final = await Anfrage.findById(anfrageA1._id).populate('ZugewieseneSlots.slot');
            const a2_final = await Anfrage.findById(anfrageA2._id).populate('ZugewieseneSlots.slot');
            const a3_final = await Anfrage.findById(anfrageA3._id).populate('ZugewieseneSlots.slot');
            const a4_final = await Anfrage.findById(anfrageA4._id).populate('ZugewieseneSlots.slot');

            // ANFRAGE A1 (Gewinner)
            expect(a1_final.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('bestaetigt_topf_entgelt');
            expect(a1_final.Status).toBe('vollstaendig_bestaetigt_topf'); // oder anderer passender Gesamtstatus

            // ANFRAGE A2 & A3 (Gleichstand, warten auf HP)
            expect(a2_final.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('wartet_hoechstpreis_topf');
            expect(a2_final.Status).toBe('in_konfliktloesung_topf'); // Gesamtstatus reflektiert den offenen Punkt
            expect(a3_final.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('wartet_hoechstpreis_topf');
            expect(a3_final.Status).toBe('in_konfliktloesung_topf');

            // ANFRAGE A4 (Verlierer)
            expect(a4_final.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('abgelehnt_topf_entgelt');
            expect(a4_final.Status).toBe('final_abgelehnt'); // Gesamtstatus reflektiert die Ablehnung
        });

        // TESTFALL für die Verarbeitung der Höchstpreis-Ergebnisse mit eindeutigen Geboten
        it('HP.1: sollte Konflikt nach Verarbeitung valider Höchstpreis-Gebote korrekt lösen (eindeutiger Gewinner)', async () => {
            // ---- SETUP: Konflikt in Status 'in_bearbeitung_hoechstpreis' bringen ----
            let kt_HP, anfrageHP_A1, anfrageHP_B, anfrageHP_C, anfrageHP_D, konfliktDokuHP_Id;
            const slotGrundentgeltHP = 100;

            // 1. Kapazitätstopf KT_HP mit maxKapazitaet = 2
            const topfKriterienHP = { Abschnitt: "HP_Zone1", Kalenderwoche: 7, Verkehrstag: "Mo-Fr", Verkehrsart: "SPNV", AbfahrtStundeFuerZeitfenster: 9 };
            const slotBasisHP = { von: "HP1", bis: "HP2", Abschnitt: topfKriterienHP.Abschnitt, Ankunft: { stunde: 10, minute: 0 }, Verkehrstag: topfKriterienHP.Verkehrstag, Kalenderwoche: topfKriterienHP.Kalenderwoche, Verkehrsart: topfKriterienHP.Verkehrsart, Grundentgelt: slotGrundentgeltHP };
            const sHP1Resp = await request(app).post('/api/slots').send({ ...slotBasisHP, Abfahrt: { stunde: topfKriterienHP.AbfahrtStundeFuerZeitfenster, minute: 10 } });
            // Erstelle 3 Slots, um maxKapazitaet = 2 zu erhalten
            await request(app).post('/api/slots').send({ ...slotBasisHP, Abfahrt: { stunde: topfKriterienHP.AbfahrtStundeFuerZeitfenster, minute: 20 } });
            await request(app).post('/api/slots').send({ ...slotBasisHP, Abfahrt: { stunde: topfKriterienHP.AbfahrtStundeFuerZeitfenster, minute: 30 } });
            kt_HP = await Kapazitaetstopf.findById(sHP1Resp.body.data.VerweisAufTopf);
            expect(kt_HP.maxKapazitaet).toBe(2);

            // 2. Anfragen erstellen: A1 (1000), B (900), C (900), D(800)
            const anfrageBasisHP = { 
                Email: "hp1@evu.com", Verkehrsart: "SPNV", Verkehrstag: "Mo-Fr", 
                ListeGewuenschterSlotAbschnitte: [{von: "HP1", bis:"HP2", Abfahrtszeit: {stunde:9, minute:0}, Ankunftszeit:{stunde:10,minute:0}}], 
                // Annahme, dass der Zuordnungsprozess jeder Anfrage alle 3 Slots zuwies
                ZugewieseneSlots: (await Slot.find({ VerweisAufTopf: kt_HP._id })).map(s => ({ slot: s._id, statusEinzelzuweisung: 'initial_in_konfliktpruefung_topf' }))
            };
            
            const zeitraumA1 = { start: "2025-02-17", ende: "2025-02-28" }; // 10 Tage
            anfrageHP_A1 = await new Anfrage({ ...anfrageBasisHP, EVU: "HPEVU11", Zugnummer: "HPA1", Zeitraum: zeitraumA1, Entgelt: 10 * slotGrundentgeltHP, Status: "in_konfliktloesung_topf" }).save();
            const zeitraumBC = { start: "2025-02-17", ende: "2025-02-27" }; // 9 Tage
            anfrageHP_B = await new Anfrage({ ...anfrageBasisHP, EVU: "HPEVU12", Zugnummer: "HPB", Zeitraum: zeitraumBC, Entgelt: 9 * slotGrundentgeltHP, Status: "in_konfliktloesung_topf" }).save();
            anfrageHP_C = await new Anfrage({ ...anfrageBasisHP, EVU: "HPEVU13", Zugnummer: "HPC", Zeitraum: zeitraumBC, Entgelt: 9 * slotGrundentgeltHP, Status: "in_konfliktloesung_topf" }).save();
            const zeitraumD = { start: "2025-02-17", ende: "2025-02-25" }; // 7 Tage
            anfrageHP_D = await new Anfrage({ ...anfrageBasisHP, EVU: "HPEVU14", Zugnummer: "HPD", Zeitraum: zeitraumD, Entgelt: 7 * slotGrundentgeltHP, Status: "in_konfliktloesung_topf" }).save();
            
            kt_HP.ListeDerAnfragen = [anfrageHP_A1._id, anfrageHP_B._id, anfrageHP_C._id, anfrageHP_D._id];
            await kt_HP.save();

            // 3. Konfliktdokument erstellen und in den Status 'in_bearbeitung_hoechstpreis' bringen
            const identResp = await request(app).post('/api/konflikte/identifiziere-topf-konflikte').send();
            konfliktDokuHP_Id = identResp.body.neuErstellteKonflikte[0].id;
            
            const entgeltVergleichPayload = {}; // Leerer Body reicht
            const entgeltResp = await request(app).put(`/api/konflikte/${konfliktDokuHP_Id}/entgeltvergleich`).send(entgeltVergleichPayload);
            expect(entgeltResp.body.data.status).toBe('in_bearbeitung_hoechstpreis'); // Verifiziere den Ausgangsstatus

            // ---- AKTION: Ergebnisse des Höchstpreisverfahrens senden ----
            const hoechstpreisPayload = {
                ListeGeboteHoechstpreis: [
                    { anfrage: anfrageHP_B._id.toString(), gebot: (anfrageHP_B.Entgelt || 0) + 50 }, // Bietet 950
                    { anfrage: anfrageHP_C._id.toString(), gebot: (anfrageHP_C.Entgelt || 0) + 20 }  // C bietet 920
                ]
            };

            const response = await request(app)
                .put(`/api/konflikte/${konfliktDokuHP_Id}/hoechstpreis-ergebnis`) // Neuer Endpunkt
                .send(hoechstpreisPayload);

            // ---- ÜBERPRÜFUNG ----
            expect(response.status).toBe(200);
            const finalKonfliktDoku = response.body.data;
            //console.log(finalKonfliktDoku);

            // 1. Überprüfung des Konfliktdokuments
            expect(finalKonfliktDoku.status).toBe('geloest');
            expect(finalKonfliktDoku.abschlussdatum).toBeDefined();
            expect(finalKonfliktDoku.zugewieseneAnfragen).toHaveLength(2); // A1 + B
            expect(finalKonfliktDoku.abgelehnteAnfragenHoechstpreis).toHaveLength(1); // C
            expect(finalKonfliktDoku.abgelehnteAnfragenEntgeltvergleich).toHaveLength(1); // D

            // 2. Überprüfung der Anfragen-Status (Gesamt und Einzelzuweisung)
            const a1_final = await Anfrage.findById(anfrageHP_A1._id).populate('ZugewieseneSlots.slot');
            const b_final = await Anfrage.findById(anfrageHP_B._id).populate('ZugewieseneSlots.slot');
            const c_final = await Anfrage.findById(anfrageHP_C._id).populate('ZugewieseneSlots.slot');
            const d_final = await Anfrage.findById(anfrageHP_D._id).populate('ZugewieseneSlots.slot');

            // ANFRAGE A1 (Gewinner aus Entgeltrunde)
            // statusEinzelzuweisung sollte 'bestaetigt_topf_entgelt' sein
            for (const zuweisung of a1_final.ZugewieseneSlots) {
                if (zuweisung.slot.VerweisAufTopf.equals(kt_HP._id)) {
                    expect(zuweisung.statusEinzelzuweisung).toBe('bestaetigt_topf_entgelt');
                }
            }
            expect(a1_final.Status).toBe('vollstaendig_bestaetigt_topf'); // Gesamtstatus sollte positiv sein
            
            // ANFRAGE B (Gewinner aus HP-Runde)
            for (const zuweisung of b_final.ZugewieseneSlots) {
                if (zuweisung.slot.VerweisAufTopf.equals(kt_HP._id)) {
                    expect(zuweisung.statusEinzelzuweisung).toBe('bestaetigt_topf_hoechstpreis');
                }
            }
            expect(b_final.Status).toBe('vollstaendig_bestaetigt_topf');

            // ANFRAGE C (Verlierer aus HP-Runde)
            for (const zuweisung of c_final.ZugewieseneSlots) {
                if (zuweisung.slot.VerweisAufTopf.equals(kt_HP._id)) {
                    expect(zuweisung.statusEinzelzuweisung).toBe('abgelehnt_topf_hoechstpreis');
                }
            }
            expect(c_final.Status).toBe('final_abgelehnt');

            // ANFRAGE D (Verlierer aus Entgeltrunde)
            for (const zuweisung of d_final.ZugewieseneSlots) {
                if (zuweisung.slot.VerweisAufTopf.equals(kt_HP._id)) {
                    expect(zuweisung.statusEinzelzuweisung).toBe('abgelehnt_topf_entgelt');
                }
            }
            expect(d_final.Status).toBe('final_abgelehnt');
        });

        //  TESTFALL für Gleichstand im Höchstpreisverfahren
        it('HP.2: sollte bei Gleichstand der höchsten Gebote im Höchstpreisverfahren den Status beibehalten und betroffene Anfragen auf "wartet" belassen', async () => {
        // ---- SETUP: Konflikt in Status 'in_bearbeitung_hoechstpreis' bringen ----
        let kt_HPTie, anfrage_HPT_A1, anfrage_HPT_B, anfrage_HPT_C, anfrage_HPT_E;
        let konfliktDokuHPTie_Id;
        const slotGrundentgeltHP = 100;

        // 1. Kapazitätstopf mit maxKapazitaet = 2
        const topfKriterienHPTie = { Abschnitt: "HPTieZone", Kalenderwoche: 8, Verkehrstag: "Mo-Fr", Verkehrsart: "SPFV", AbfahrtStundeFuerZeitfenster: 9 };
        const slotBasisHPTie = { von: "TIE1", bis: "TIE2", Abschnitt: topfKriterienHPTie.Abschnitt, Ankunft: { stunde: 10, minute: 0 }, Verkehrstag: topfKriterienHPTie.Verkehrstag, Kalenderwoche: topfKriterienHPTie.Kalenderwoche, Verkehrsart: topfKriterienHPTie.Verkehrsart, Grundentgelt: slotGrundentgeltHP };
        // 3 Slots erstellen, um maxKapazitaet = 2 zu erhalten
        const sHPT1Resp = await request(app).post('/api/slots').send({ ...slotBasisHPTie, Abfahrt: { stunde: topfKriterienHPTie.AbfahrtStundeFuerZeitfenster, minute: 10 } });
        await request(app).post('/api/slots').send({ ...slotBasisHPTie, Abfahrt: { stunde: topfKriterienHPTie.AbfahrtStundeFuerZeitfenster, minute: 20 } });
        await request(app).post('/api/slots').send({ ...slotBasisHPTie, Abfahrt: { stunde: topfKriterienHPTie.AbfahrtStundeFuerZeitfenster, minute: 30 } });
        kt_HPTie = await Kapazitaetstopf.findById(sHPT1Resp.body.data.VerweisAufTopf);
        expect(kt_HPTie.maxKapazitaet).toBe(2);

        // 2. Anfragen erstellen: A1 (1000), B (900), C (900), E (900)
        // Der Einfachheit halber gehen wir davon aus, dass alle Anfragen die gleichen Slots wollen.
        const zugewieseneSlotsFuerAnfragen = (await Slot.find({ VerweisAufTopf: kt_HPTie._id })).map(s => ({
            slot: s._id,
            statusEinzelzuweisung: 'initial_in_konfliktpruefung_topf'
        }));
        const anfrageBasisHPTie = { Email: "hptie@evu.com", Verkehrsart: "SPFV", Verkehrstag: "Mo-Fr", ListeGewuenschterSlotAbschnitte: [{von: "TIE1", bis:"TIE2", Abfahrtszeit: {stunde:9, minute:0}, Ankunftszeit:{stunde:10,minute:0}}], ZugewieseneSlots: zugewieseneSlotsFuerAnfragen };
        
        const zeitraumA1 = { start: "2025-02-24", ende: "2025-03-07" }; // 10 Tage
        anfrage_HPT_A1 = await new Anfrage({ ...anfrageBasisHPTie, EVU: "HPTIE_EVU1", Zugnummer: "HPTA1", Zeitraum: zeitraumA1, Entgelt: 10 * slotGrundentgeltHP, Status: "in_konfliktloesung_topf" }).save();
        const zeitraumRest = { start: "2025-02-24", ende: "2025-03-06" }; // 9 Tage
        anfrage_HPT_B = await new Anfrage({ ...anfrageBasisHPTie, EVU: "HPTIE_EVU2", Zugnummer: "HPTB", Zeitraum: zeitraumRest, Entgelt: 9 * slotGrundentgeltHP, Status: "in_konfliktloesung_topf" }).save();
        anfrage_HPT_C = await new Anfrage({ ...anfrageBasisHPTie, EVU: "HPTIE_EVU3", Zugnummer: "HPTC", Zeitraum: zeitraumRest, Entgelt: 9 * slotGrundentgeltHP, Status: "in_konfliktloesung_topf" }).save();
        anfrage_HPT_E = await new Anfrage({ ...anfrageBasisHPTie, EVU: "HPTIE_EVU4", Zugnummer: "HPTE", Zeitraum: zeitraumRest, Entgelt: 9 * slotGrundentgeltHP, Status: "in_konfliktloesung_topf" }).save(); // E hat auch 900
        
        kt_HPTie.ListeDerAnfragen = [anfrage_HPT_A1._id, anfrage_HPT_B._id, anfrage_HPT_C._id, anfrage_HPT_E._id];
        await kt_HPTie.save();

        // 3. Konfliktdokument erstellen und durch Entgeltvergleich in den Status 'in_bearbeitung_hoechstpreis' bringen
        const identResp = await request(app).post('/api/konflikte/identifiziere-topf-konflikte').send();
        konfliktDokuHPTie_Id = identResp.body.neuErstellteKonflikte[0].id;
        
        const entgeltVergleichPayload = {};
        const entgeltResp = await request(app).put(`/api/konflikte/${konfliktDokuHPTie_Id}/entgeltvergleich`).send(entgeltVergleichPayload);
        expect(entgeltResp.body.data.status).toBe('in_bearbeitung_hoechstpreis');
        // Nach diesem Schritt ist A1 zugewiesen, B, C, und E warten auf das Höchstpreisverfahren für den verbleibenden 1 Platz.

        // ---- AKTION: Ergebnisse des Höchstpreisverfahrens senden, mit Gleichstand für den letzten Platz ----
        // Annahme: B und C bieten gleich viel (950), E bietet weniger (920). Es ist 1 Platz frei.
        const hoechstpreisPayloadTie = {
            ListeGeboteHoechstpreis: [
                { anfrage: anfrage_HPT_B._id.toString(), gebot: (anfrage_HPT_B.Entgelt || 0) + 50 }, // bietet 950
                { anfrage: anfrage_HPT_C._id.toString(), gebot: (anfrage_HPT_C.Entgelt || 0) + 50 }, // bietet auch 950
                { anfrage: anfrage_HPT_E._id.toString(), gebot: (anfrage_HPT_E.Entgelt || 0) + 20 }  // bietet nur 920
            ]
        };

        const response = await request(app)
            .put(`/api/konflikte/${konfliktDokuHPTie_Id}/hoechstpreis-ergebnis`) // Neuer Endpunkt
            .send(hoechstpreisPayloadTie);

        // ---- ÜBERPRÜFUNG ----
        // 1. Überprüfung des Konfliktdokuments
        expect(response.status).toBe(200);
        const finalKonfliktDoku = response.body.data;
        expect(finalKonfliktDoku.status).toBe('in_bearbeitung_hoechstpreis'); // Sollte im HP-Status bleiben
        expect(finalKonfliktDoku.abschlussdatum).toBeUndefined(); // Noch nicht gelöst

        // zugewieseneAnfragen sollte immer noch nur A1 enthalten
        expect(finalKonfliktDoku.zugewieseneAnfragen).toHaveLength(1);
        expect(finalKonfliktDoku.zugewieseneAnfragen[0].toString()).toBe(anfrage_HPT_A1._id.toString());

        // abgelehnteAnfragen aus Höchstpreis: Nur E (da eindeutig unterboten)
        expect(finalKonfliktDoku.abgelehnteAnfragenHoechstpreis).toHaveLength(1);
        expect(finalKonfliktDoku.abgelehnteAnfragenHoechstpreis[0].toString()).toBe(anfrage_HPT_E._id.toString());
        expect(finalKonfliktDoku.notizen).toContain("Erneuter Gleichstand");

        // 2. Überprüfung der Anfragen-Status
        const a1_final = await Anfrage.findById(anfrage_HPT_A1._id).populate('ZugewieseneSlots.slot');
        const b_final = await Anfrage.findById(anfrage_HPT_B._id).populate('ZugewieseneSlots.slot');
        const c_final = await Anfrage.findById(anfrage_HPT_C._id).populate('ZugewieseneSlots.slot');
        const e_final = await Anfrage.findById(anfrage_HPT_E._id).populate('ZugewieseneSlots.slot');

        // ANFRAGE A1 (Gewinner aus Entgeltrunde)
        for (const zuweisung of a1_final.ZugewieseneSlots) {
            if (zuweisung.slot.VerweisAufTopf.equals(kt_HPTie._id)) {
                expect(zuweisung.statusEinzelzuweisung).toBe('bestaetigt_topf_entgelt');
            }
        }
        expect(a1_final.Status).toBe('vollstaendig_bestaetigt_topf');

        // ANFRAGE B & C (Gleichstand, warten auf nächste HP-Runde)
        for (const zuweisung of b_final.ZugewieseneSlots) {
            if (zuweisung.slot.VerweisAufTopf.equals(kt_HPTie._id)) {
                expect(zuweisung.statusEinzelzuweisung).toBe('wartet_hoechstpreis_topf');
            }
        }
        expect(b_final.Status).toBe('in_konfliktloesung_topf');
        for (const zuweisung of c_final.ZugewieseneSlots) {
            if (zuweisung.slot.VerweisAufTopf.equals(kt_HPTie._id)) {
                expect(zuweisung.statusEinzelzuweisung).toBe('wartet_hoechstpreis_topf');
            }
        }
        expect(c_final.Status).toBe('in_konfliktloesung_topf');


        // ANFRAGE E (Verlierer aus HP-Runde)
        for (const zuweisung of e_final.ZugewieseneSlots) {
            if (zuweisung.slot.VerweisAufTopf.equals(kt_HPTie._id)) {
                expect(zuweisung.statusEinzelzuweisung).toBe('abgelehnt_topf_hoechstpreis');
            }
        }
        expect(e_final.Status).toBe('final_abgelehnt');
    });

    // TESTFALL für ungültiges Gebot im Höchstpreisverfahren
    it('HP.3: sollte eine Anfrage mit ungültigem Gebot (<= Entgelt) ablehnen und den Konflikt korrekt lösen', async () => {
            // ---- SETUP: Konflikt in Status 'in_bearbeitung_hoechstpreis' bringen ----
            let kt_InvBid, anfrageInv_A1, anfrageInv_B, anfrageInv_C;
            let konfliktDokuInvBid_Id;
            const slotGrundentgeltInv = 50;

            // 1. Kapazitätstopf KT_InvBid mit maxKapazitaet = 1
            const topfKriterienInv = { Abschnitt: "InvBidZone", Kalenderwoche: 9, Verkehrstag: "Sa+So", Verkehrsart: "SGV", AbfahrtStundeFuerZeitfenster: 13 };
            const slotBasisInv = { von: "INV1", bis: "INV2", Abschnitt: topfKriterienInv.Abschnitt, Ankunft: { stunde: 14, minute: 0 }, Verkehrstag: topfKriterienInv.Verkehrstag, Kalenderwoche: topfKriterienInv.Kalenderwoche, Verkehrsart: topfKriterienInv.Verkehrsart, Grundentgelt: slotGrundentgeltInv };
            // 2 Slots erstellen, um maxKap = floor(0.7*2) = 1 zu erhalten
            const sInv1Resp = await request(app).post('/api/slots').send({ ...slotBasisInv, Abfahrt: { stunde: topfKriterienInv.AbfahrtStundeFuerZeitfenster, minute: 10 } });
            await request(app).post('/api/slots').send({ ...slotBasisInv, Abfahrt: { stunde: topfKriterienInv.AbfahrtStundeFuerZeitfenster, minute: 20 } });
            kt_InvBid = await Kapazitaetstopf.findById(sInv1Resp.body.data.VerweisAufTopf);
            expect(kt_InvBid.maxKapazitaet).toBe(1);

            // 2. Anfragen erstellen: A1 (200), B (150), C (100)
            const anfrageBasisInv = { Email: "invbid@evu.com", Verkehrsart: "SGV", Verkehrstag: "Sa+So", ListeGewuenschterSlotAbschnitte: [{von: "INV1", bis:"INV2", Abfahrtszeit: {stunde:13, minute:0}, Ankunftszeit:{stunde:14,minute:0}}], ZugewieseneSlots: [{ slot: sInv1Resp.body.data._id, statusEinzelzuweisung: 'initial_in_konfliktpruefung_topf' }] };
            const zeitraumA1 = { start: "2025-03-01", ende: "2025-03-09" }; // 4 Tage (2x Sa+So)
            anfrageInv_A1 = await new Anfrage({ ...anfrageBasisInv, EVU: "InvBidEVU1", Zugnummer: "InvA1", Zeitraum: zeitraumA1, Entgelt: 4 * slotGrundentgeltInv, Status: "in_konfliktloesung_topf" }).save(); // Entgelt 200
            
            const zeitraumB = { start: "2025-03-01", ende: "2025-03-09" }; // 4 Tage (2x Sa, 1x So)
            anfrageInv_B = await new Anfrage({ ...anfrageBasisInv, EVU: "InvBidEVU2", Zugnummer: "InvB", Zeitraum: zeitraumB, Entgelt: 4 * slotGrundentgeltInv, Status: "in_konfliktloesung_topf" }).save(); // Entgelt 200

            const zeitraumC = { start: "2025-03-01", ende: "2025-03-02" }; // 2 Tage (1x Sa+So)
            anfrageInv_C = await new Anfrage({ ...anfrageBasisInv, EVU: "InvBidEVU3", Zugnummer: "InvC", Zeitraum: zeitraumC, Entgelt: 2 * slotGrundentgeltInv, Status: "in_konfliktloesung_topf" }).save(); // Entgelt 100

            // 3. Konflikt erzeugen und in HP-Status bringen
            kt_InvBid.ListeDerAnfragen = [anfrageInv_A1._id, anfrageInv_B._id, anfrageInv_C._id];
            await kt_InvBid.save();
            const identResp_Inv = await request(app).post('/api/konflikte/identifiziere-topf-konflikte').send();
            konfliktDokuInvBid_Id = identResp_Inv.body.neuErstellteKonflikte[0].id;
            
            const entgeltVergleichPayload_Inv = { };
            const entgeltResp_Inv = await request(app).put(`/api/konflikte/${konfliktDokuInvBid_Id}/entgeltvergleich`).send(entgeltVergleichPayload_Inv);
            expect(entgeltResp_Inv.body.data.status).toBe('in_bearbeitung_hoechstpreis');
            
            // Nach diesem Schritt: maxKap=1. A1 hat 200, B hat 200, C hat 100.
            // ---- AKTION: Gebote senden, wobei B ein ungültiges Gebot abgibt ----
            const hoechstpreisPayload_InvBid = {
                ListeGeboteHoechstpreis: [
                    { anfrage: anfrageInv_B._id.toString(), gebot: 150 }, // Ungültig, da gebot (150) <= Entgelt (200)
                    { anfrage: anfrageInv_A1._id.toString(), gebot: 220 }  // Gültig, da gebot (220) > Entgelt (200)
                ]
            };

            const response = await request(app)
                .put(`/api/konflikte/${konfliktDokuInvBid_Id}/hoechstpreis-ergebnis`)
                .send(hoechstpreisPayload_InvBid);

            // ---- ÜBERPRÜFUNG ----
            expect(response.status).toBe(200);
            const finalKonfliktDoku = response.body.data;

            // 1. Überprüfung des Konfliktdokuments
            expect(finalKonfliktDoku.status).toBe('geloest');
            expect(finalKonfliktDoku.abschlussdatum).toBeDefined();

            // Zugewiesene Anfragen: Nur A1 (da B's Gebot ungültig war)
            expect(finalKonfliktDoku.zugewieseneAnfragen).toHaveLength(1);
            expect(finalKonfliktDoku.zugewieseneAnfragen[0].toString()).toBe(anfrageInv_A1._id.toString());

            // Abgelehnte Anfragen aus Höchstpreis: Nur B (wegen ungültigem Gebot)
            // C wurde schon vorher beim Entgeltvergleich abgelehnt.
            expect(finalKonfliktDoku.abgelehnteAnfragenHoechstpreis).toHaveLength(1);
            expect(finalKonfliktDoku.abgelehnteAnfragenHoechstpreis[0].toString()).toBe(anfrageInv_B._id.toString());
            expect(finalKonfliktDoku.abgelehnteAnfragenEntgeltvergleich.map(id => id.toString())).toContain(anfrageInv_C._id.toString());
            
            // 2. Überprüfung der Anfragen-Status
            const a1_final = await Anfrage.findById(anfrageInv_A1._id).populate('ZugewieseneSlots.slot');
            const b_final = await Anfrage.findById(anfrageInv_B._id).populate('ZugewieseneSlots.slot');
            const c_final = await Anfrage.findById(anfrageInv_C._id).populate('ZugewieseneSlots.slot');

            // ANFRAGE A1 (Gewinner aus HP-Runde)
            for (const zuweisung of a1_final.ZugewieseneSlots) {
                if (zuweisung.slot.VerweisAufTopf.equals(kt_InvBid._id)) {
                    expect(zuweisung.statusEinzelzuweisung).toBe('bestaetigt_topf_hoechstpreis');
                }
            }
            expect(a1_final.Status).toBe('vollstaendig_bestaetigt_topf');
            
            // ANFRAGE B (Verlierer wegen ungültigem Gebot)
            for (const zuweisung of b_final.ZugewieseneSlots) {
                if (zuweisung.slot.VerweisAufTopf.equals(kt_InvBid._id)) {
                    expect(zuweisung.statusEinzelzuweisung).toBe('abgelehnt_topf_hoechstpreis_ungueltig');
                }
            }
            expect(b_final.Status).toBe('final_abgelehnt');

            // ANFRAGE C (Verlierer aus Entgeltrunde)
             for (const zuweisung of c_final.ZugewieseneSlots) {
                if (zuweisung.slot.VerweisAufTopf.equals(kt_InvBid._id)) {
                    expect(zuweisung.statusEinzelzuweisung).toBe('abgelehnt_topf_entgelt');
                }
            }
            expect(c_final.Status).toBe('final_abgelehnt');
        });   
        
    // TESTFALL für fehlendes Gebot im Höchstpreisverfahren
    it('HP.4: sollte eine Anfrage mit fehlendem Gebot ablehnen und den Konflikt korrekt lösen', async () => {
            // ---- SETUP: Konflikt in Status 'in_bearbeitung_hoechstpreis' bringen ----
            let kt_InvBid, anfrageInv_A1, anfrageInv_B, anfrageInv_C;
            let konfliktDokuInvBid_Id;
            const slotGrundentgeltInv = 50;

            // 1. Kapazitätstopf KT_InvBid mit maxKapazitaet = 1
            const topfKriterienInv = { Abschnitt: "InvBidZone", Kalenderwoche: 9, Verkehrstag: "Sa+So", Verkehrsart: "SGV", AbfahrtStundeFuerZeitfenster: 13 };
            const slotBasisInv = { von: "INV1", bis: "INV2", Abschnitt: topfKriterienInv.Abschnitt, Ankunft: { stunde: 14, minute: 0 }, Verkehrstag: topfKriterienInv.Verkehrstag, Kalenderwoche: topfKriterienInv.Kalenderwoche, Verkehrsart: topfKriterienInv.Verkehrsart, Grundentgelt: slotGrundentgeltInv };
            // 2 Slots erstellen, um maxKap = floor(0.7*2) = 1 zu erhalten
            const sInv1Resp = await request(app).post('/api/slots').send({ ...slotBasisInv, Abfahrt: { stunde: topfKriterienInv.AbfahrtStundeFuerZeitfenster, minute: 10 } });
            await request(app).post('/api/slots').send({ ...slotBasisInv, Abfahrt: { stunde: topfKriterienInv.AbfahrtStundeFuerZeitfenster, minute: 20 } });
            kt_InvBid = await Kapazitaetstopf.findById(sInv1Resp.body.data.VerweisAufTopf);
            expect(kt_InvBid.maxKapazitaet).toBe(1);

            // 2. Anfragen erstellen: A1 (200), B (150), C (100)
            const anfrageBasisInv = { Email: "invbid@evu.com", Verkehrsart: "SGV", Verkehrstag: "Sa+So", ListeGewuenschterSlotAbschnitte: [{von: "INV1", bis:"INV2", Abfahrtszeit: {stunde:13, minute:0}, Ankunftszeit:{stunde:14,minute:0}}], ZugewieseneSlots: [{ slot: sInv1Resp.body.data._id, statusEinzelzuweisung: 'initial_in_konfliktpruefung_topf' }] };
            const zeitraumA1 = { start: "2025-03-01", ende: "2025-03-09" }; // 4 Tage (2x Sa+So)
            anfrageInv_A1 = await new Anfrage({ ...anfrageBasisInv, EVU: "InvBidEVU4", Zugnummer: "InvA1", Zeitraum: zeitraumA1, Entgelt: 4 * slotGrundentgeltInv, Status: "in_konfliktloesung_topf" }).save(); // Entgelt 200
            
            const zeitraumB = { start: "2025-03-01", ende: "2025-03-09" }; // 4 Tage (2x Sa, 1x So)
            anfrageInv_B = await new Anfrage({ ...anfrageBasisInv, EVU: "InvBidEVU5", Zugnummer: "InvB", Zeitraum: zeitraumB, Entgelt: 4 * slotGrundentgeltInv, Status: "in_konfliktloesung_topf" }).save(); // Entgelt 200

            const zeitraumC = { start: "2025-03-01", ende: "2025-03-02" }; // 2 Tage (1x Sa+So)
            anfrageInv_C = await new Anfrage({ ...anfrageBasisInv, EVU: "InvBidEVU6", Zugnummer: "InvC", Zeitraum: zeitraumC, Entgelt: 2 * slotGrundentgeltInv, Status: "in_konfliktloesung_topf" }).save(); // Entgelt 100

            // 3. Konflikt erzeugen und in HP-Status bringen
            kt_InvBid.ListeDerAnfragen = [anfrageInv_A1._id, anfrageInv_B._id, anfrageInv_C._id];
            await kt_InvBid.save();
            const identResp_Inv = await request(app).post('/api/konflikte/identifiziere-topf-konflikte').send();
            konfliktDokuInvBid_Id = identResp_Inv.body.neuErstellteKonflikte[0].id;
            
            const entgeltVergleichPayload_Inv = { };
            const entgeltResp_Inv = await request(app).put(`/api/konflikte/${konfliktDokuInvBid_Id}/entgeltvergleich`).send(entgeltVergleichPayload_Inv);
            expect(entgeltResp_Inv.body.data.status).toBe('in_bearbeitung_hoechstpreis');
            
            // Nach diesem Schritt: maxKap=1. A1 hat 200, B hat 200, C hat 100.
            // ---- AKTION: Gebote senden, wobei B ein ungültiges Gebot abgibt ----
            const hoechstpreisPayload_InvBid = {
                ListeGeboteHoechstpreis: [
                    // Anfrage B gibt ekin Gebot ab
                    { anfrage: anfrageInv_A1._id.toString(), gebot: 220 }  // Gültig, da gebot (220) > Entgelt (200)
                ]
            };

            const response = await request(app)
                .put(`/api/konflikte/${konfliktDokuInvBid_Id}/hoechstpreis-ergebnis`)
                .send(hoechstpreisPayload_InvBid);

            // ---- ÜBERPRÜFUNG ----
            expect(response.status).toBe(200);
            const finalKonfliktDoku = response.body.data;

            // 1. Überprüfung des Konfliktdokuments
            expect(finalKonfliktDoku.status).toBe('geloest');
            expect(finalKonfliktDoku.abschlussdatum).toBeDefined();

            // Zugewiesene Anfragen: Nur A1 (da B's Gebot ungültig war)
            expect(finalKonfliktDoku.zugewieseneAnfragen).toHaveLength(1);
            expect(finalKonfliktDoku.zugewieseneAnfragen[0].toString()).toBe(anfrageInv_A1._id.toString());

            // Abgelehnte Anfragen aus Höchstpreis: Nur B (wegen fehlendem Gebot)
            // C wurde schon vorher beim Entgeltvergleich abgelehnt.
            expect(finalKonfliktDoku.abgelehnteAnfragenHoechstpreis).toHaveLength(1);
            expect(finalKonfliktDoku.abgelehnteAnfragenHoechstpreis[0].toString()).toBe(anfrageInv_B._id.toString());
            expect(finalKonfliktDoku.abgelehnteAnfragenEntgeltvergleich.map(id => id.toString())).toContain(anfrageInv_C._id.toString());
            
            // 2. Überprüfung der Anfragen-Status
            const a1_final = await Anfrage.findById(anfrageInv_A1._id).populate('ZugewieseneSlots.slot');
            const b_final = await Anfrage.findById(anfrageInv_B._id).populate('ZugewieseneSlots.slot');
            const c_final = await Anfrage.findById(anfrageInv_C._id).populate('ZugewieseneSlots.slot');

            // ANFRAGE A1 (Gewinner aus HP-Runde)
            for (const zuweisung of a1_final.ZugewieseneSlots) {
                if (zuweisung.slot.VerweisAufTopf.equals(kt_InvBid._id)) {
                    expect(zuweisung.statusEinzelzuweisung).toBe('bestaetigt_topf_hoechstpreis');
                }
            }
            expect(a1_final.Status).toBe('vollstaendig_bestaetigt_topf');
            
            // ANFRAGE B (Verlierer wegen ungültigem Gebot)
            for (const zuweisung of b_final.ZugewieseneSlots) {
                if (zuweisung.slot.VerweisAufTopf.equals(kt_InvBid._id)) {
                    expect(zuweisung.statusEinzelzuweisung).toBe('abgelehnt_topf_hoechstpreis_kein_gebot');
                }
            }
            expect(b_final.Status).toBe('final_abgelehnt');

            // ANFRAGE C (Verlierer aus Entgeltrunde)
             for (const zuweisung of c_final.ZugewieseneSlots) {
                if (zuweisung.slot.VerweisAufTopf.equals(kt_InvBid._id)) {
                    expect(zuweisung.statusEinzelzuweisung).toBe('abgelehnt_topf_entgelt');
                }
            }
            expect(c_final.Status).toBe('final_abgelehnt');
        });  

    });

describe('GET /api/konflikte/gruppen/:gruppenId/verschiebe-analyse', () => {
    let kt_0507, kt_0709, kt_0911;
    let anfragenFuerKonflikt = [];
    let anfragenFuerBelegung = [];
    let konfliktGruppe;
    let konfliktGruppe2;

    // Wenn du manuelle Bereinigung pro Testfall brauchst:
        beforeAll(async () => {
            // Mongoose Verbindung herstellen, wenn nicht schon global geschehen
            // Diese Verbindung muss die URI zur Docker-DB nutzen
            await mongoose.connect(process.env.TEST_MONGO_URI || 'mongodb://localhost:27017/test-mongo-slots');
        });
    
        afterAll(async () => {
            await mongoose.disconnect();
        });

    // Das Setup für diesen Test ist etwas umfangreicher
    beforeEach(async () => {
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

        // 1. Erstelle die 3 Kapazitätstöpfe durch Slot-Erstellung.
        // Alle Töpfe sollen maxKapazitaet = 2 haben (dafür jeweils 3 Slots erstellen).
        anfragenFuerKonflikt = [];
        anfragenFuerBelegung = [];

        const commonParams = {
            von: "Analyse-A", bis: "Analyse-B", Abschnitt: "Analyse-Strecke",
            Verkehrsart: "SPFV", Verkehrstag: "Mo-Fr", Kalenderwoche: 4, Grundentgelt: 10
        };

        // Slots für Topf 05-07
        for(let i=0; i<3; i++) { await request(app).post('/api/slots').send({ ...commonParams, Abfahrt: { stunde: 5, minute: i*10 }, Ankunft: { stunde: 6, minute: i*10 } }); }
        // Slots für Topf 07-09
        for(let i=0; i<3; i++) { await request(app).post('/api/slots').send({ ...commonParams, Abfahrt: { stunde: 7, minute: i*10 }, Ankunft: { stunde: 8, minute: i*10 } }); }
        // Slots für Topf 09-11
        for(let i=0; i<3; i++) { await request(app).post('/api/slots').send({ ...commonParams, Abfahrt: { stunde: 9, minute: i*10 }, Ankunft: { stunde: 10, minute: i*10 } }); }
        
        const s1 = await Slot.findOne({Abfahrt: { stunde: 7, minute: 10 }});
        const s2 = await Slot.findOne({Abfahrt: { stunde: 9, minute: 10 }});
        //console.log(`Der gespeicherte Slot lautet ${s1}`);

        // Töpfe aus DB laden und prüfen
        kt_0507 = await Kapazitaetstopf.findOne({ Abschnitt: "Analyse-Strecke", Zeitfenster: "05-07", Kalenderwoche: 4 });
        kt_0709 = await Kapazitaetstopf.findOne({ Abschnitt: "Analyse-Strecke", Zeitfenster: "07-09", Kalenderwoche: 4 });
        kt_0911 = await Kapazitaetstopf.findOne({ Abschnitt: "Analyse-Strecke", Zeitfenster: "09-11", Kalenderwoche: 4 });
        
        expect(kt_0507).toBeDefined(); 
        expect(kt_0709).toBeDefined(); 
        expect(kt_0911).toBeDefined();
        expect(kt_0507.maxKapazitaet).toBe(2); 
        expect(kt_0709.maxKapazitaet).toBe(2); 
        expect(kt_0911.maxKapazitaet).toBe(2);
        
        // Verknüpfung der Töpfe prüfen
        expect(kt_0709.TopfIDVorgänger.toString()).toBe(kt_0507._id.toString());
        expect(kt_0709.TopfIDNachfolger.toString()).toBe(kt_0911._id.toString());

        // 2. Anfragen erstellen
        const anfrageBasis = { Email: "analyse@evu.com", Verkehrsart: "SPFV", Status: 'validiert',
                               Verkehrstag: "Mo-Fr", Zeitraum: { start: "2025-01-20", ende: "2025-01-26" },
                               ListeGewuenschterSlotAbschnitte: [{von: "Analyse-A", bis:"Analyse-B", Abfahrtszeit: {stunde:7, minute:10}, Ankunftszeit:{stunde:8,minute:10}}],
                               ZugewieseneSlots: [
                                                { slot: s1._id, statusEinzelzuweisung: 'initial_in_konfliktpruefung_topf'},
                                                // Für Einfachheit nehmen wir an, jede Anfrage bezieht sich auf einen der erstellten Slots.
                                                // In Realität würden sie sich ggf. die gleichen Slots teilen.
                                ]};
        
        // 3 Anfragen für den Konflikt in Topf 07-09
        for(let i=1; i<=3; i++) {
            const anfr = await new Anfrage({ ...anfrageBasis, EVU: `AnalyseEVU${i}`, Zugnummer: `A${i}` }).save();
            anfragenFuerKonflikt.push(anfr);
        }
        // 3 Anfragen für die Belegung von Topf 09-11
        for(let i=1; i<=3; i++) {
            const anfr = await new Anfrage({ ...anfrageBasis, EVU: `BelegungEVU${i}`, Zugnummer: `B${i}`,
                Abfahrtszeit: {stunde:9, minute:10}, Ankunftszeit:{stunde:10,minute:10},
             ZugewieseneSlots: [
                                { slot: s2._id, statusEinzelzuweisung: 'initial_in_konfliktpruefung_topf'},
                                // Für Einfachheit nehmen wir an, jede Anfrage bezieht sich auf einen der erstellten Slots.
                                // In Realität würden sie sich ggf. die gleichen Slots teilen.
                                ]}).save();
            anfragenFuerBelegung.push(anfr);
        }

        // 3. Töpfe manuell mit Anfragen befüllen, um die Situation herzustellen
        kt_0709.ListeDerAnfragen = anfragenFuerKonflikt.map(a => a._id);
        await kt_0709.save();
        kt_0911.ListeDerAnfragen = anfragenFuerBelegung.map(a => a._id);
        await kt_0911.save();
        
        // 4. Konflikt und Gruppe identifizieren
        await request(app).post('/api/konflikte/identifiziere-topf-konflikte').send();

        let r = await KonfliktGruppe.find({});
        //console.log(r);

        // Erzeuge im Test den exakten Schlüssel, den wir erwarten
        let erwarteteAnfrageIds = anfragenFuerKonflikt.map(a => a._id.toString()).sort();
        let maxEVUkapa = Math.floor(0.56 * kt_0507.ListeDerSlots.length);
        //console.log(erwarteteAnfrageIds);        
        let erwarteterGruppenSchluessel = `${kt_0507.maxKapazitaet}#${maxEVUkapa}|${erwarteteAnfrageIds.join('#')}`;

        //console.log(`Erwarteter Schlüssel Gruppe 1: ${erwarteterGruppenSchluessel}`);

        // Suche die Gruppe anhand dieses eindeutigen Schlüssels
        konfliktGruppe = await KonfliktGruppe.findOne({ 
            gruppenSchluessel: erwarteterGruppenSchluessel 
        });
        expect(konfliktGruppe).not.toBeNull();

        erwarteteAnfrageIds = anfragenFuerBelegung.map(a => a._id.toString()).sort();
        maxEVUkapa = Math.floor(0.56 * kt_0507.ListeDerSlots.length);
        erwarteterGruppenSchluessel = `${kt_0507.maxKapazitaet}#${maxEVUkapa}|${erwarteteAnfrageIds.join('#')}`;

        //console.log(`Erwarteter Schlüssel Gruppe 2: ${erwarteterGruppenSchluessel}`);

        konfliktGruppe2 = await KonfliktGruppe.findOne({ 
            gruppenSchluessel: erwarteterGruppenSchluessel 
        });
        expect(konfliktGruppe2).not.toBeNull();
    });

    it('sollte die Kapazität der Nachbartöpfe korrekt als "frei" und "belegt" analysieren', async () => {
        // Aktion: Analyse-Endpunkt aufrufen
        const response = await request(app)
            .get(`/api/konflikte/gruppen/${konfliktGruppe._id}/verschiebe-analyse`)
            .send();

        // Überprüfung
        expect(response.status).toBe(200);
        expect(response.body.data).toBeInstanceOf(Array);
        expect(response.body.data).toHaveLength(3); // Analyse für die 3 Anfragen im Konflikt

        // Überprüfe die Analyse für die erste Anfrage (die anderen sollten identisch sein)
        const analyseFuerErsteAnfrage = response.body.data.find(a => a.anfrage._id === anfragenFuerKonflikt[0]._id.toString());
        expect(analyseFuerErsteAnfrage).toBeDefined();

        expect(analyseFuerErsteAnfrage.topfAnalysen).toHaveLength(1); // Nur ein Konflikttopf in dieser Gruppe
        const topfAnalyse = analyseFuerErsteAnfrage.topfAnalysen[0];
        
        // Prüfe den auslösenden Topf
        expect(topfAnalyse.ausloesenderTopf._id).toBe(kt_0709._id.toString());
        
        // Prüfe den Vorgänger (kt_0507)
        expect(topfAnalyse.vorgänger).toBeDefined();
        expect(topfAnalyse.vorgänger._id).toBe(kt_0507._id.toString());
        expect(topfAnalyse.vorgänger.Status).toBe('frei'); // Da ListeDerAnfragen (0) < maxKapazitaet (2)

        // Prüfe den Nachfolger (kt_0911)
        expect(topfAnalyse.nachfolger).toBeDefined();
        expect(topfAnalyse.nachfolger._id).toBe(kt_0911._id.toString());
        expect(topfAnalyse.nachfolger.Status).toBe('belegt'); // Da ListeDerAnfragen (3) >== maxKapazitaet (2)
    });

    it('sollte die Kapazität der Nachbartöpfe korrekt als "belegt" und nicht existent analysieren', async () => {
        // Aktion: Analyse-Endpunkt aufrufen
        const response = await request(app)
            .get(`/api/konflikte/gruppen/${konfliktGruppe2._id}/verschiebe-analyse`)
            .send();

        // Überprüfung
        expect(response.status).toBe(200);
        expect(response.body.data).toBeInstanceOf(Array);
        expect(response.body.data).toHaveLength(3); // Analyse für die 3 Anfragen im Konflikt

        // Überprüfe die Analyse für die erste Anfrage (die anderen sollten identisch sein)
        const analyseFuerErsteAnfrage = response.body.data.find(a => a.anfrage._id === anfragenFuerBelegung[0]._id.toString());
        expect(analyseFuerErsteAnfrage).toBeDefined();

        expect(analyseFuerErsteAnfrage.topfAnalysen).toHaveLength(1); // Nur ein Konflikttopf in dieser Gruppe
        const topfAnalyse = analyseFuerErsteAnfrage.topfAnalysen[0];
        
        // Prüfe den auslösenden Topf
        expect(topfAnalyse.ausloesenderTopf._id).toBe(kt_0911._id.toString());
        
        // Prüfe den Vorgänger (kt_0709)
        expect(topfAnalyse.vorgänger).toBeDefined();
        expect(topfAnalyse.vorgänger._id).toBe(kt_0709._id.toString());
        expect(topfAnalyse.vorgänger.Status).toBe('belegt'); // // Da ListeDerAnfragen (3) >== maxKapazitaet (2)

        // Prüfe den Nachfolger (kt_1113) //der ist nicht existent
        expect(topfAnalyse.nachfolger).toBeNull();
    });
});

describe('POST /api/konflikte/identifiziere-slot-konflikte', () => {
        let kt_DetectConflict, kt_NoConflict, kt_NoConflict2;
        let anfragenIds = [];
        let s1 = '';

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

            // Vorbereitung: Kapazitätstopf mit maxKapazitaet = 2 erstellen
            const topfKriterien = {
                Abschnitt: "KonfliktZone1", Kalenderwoche: 2, Verkehrstag: "Sa+So",
                Verkehrsart: "SGV", AbfahrtStundeFuerZeitfenster: 13 // Ergibt ZF "13-15"
            };
            const topfKriterien2 = {
                Abschnitt: "KonfliktZone2", Kalenderwoche: 2, Verkehrstag: "Sa+So",
                Verkehrsart: "SGV", AbfahrtStundeFuerZeitfenster: 15 // Ergibt ZF "13-15"
            };
            const topfKriterien3 = {
                Abschnitt: "KonfliktZone3", Kalenderwoche: 2, Verkehrstag: "Sa+So",
                Verkehrsart: "SGV", AbfahrtStundeFuerZeitfenster: 13 // Ergibt ZF "13-15"
            };
            // 3 Slots für KonfliktZone1 erstellen, um maxKapazitaet = floor(0.7*3) = 2 zu erhalten
            const slotBasis = { von: "Y", bis: "Z", Abschnitt: topfKriterien.Abschnitt, Ankunft: { stunde: 14, minute: 0 }, 
                                Verkehrstag: topfKriterien.Verkehrstag, Kalenderwoche: topfKriterien.Kalenderwoche, 
                                Verkehrsart: topfKriterien.Verkehrsart,
                                Grundentgelt: 150 
                            };
            s1 = await request(app).post('/api/slots').send({ ...slotBasis, Abfahrt: { stunde: topfKriterien.AbfahrtStundeFuerZeitfenster, minute: 10 } });
            await request(app).post('/api/slots').send({ ...slotBasis, Abfahrt: { stunde: topfKriterien.AbfahrtStundeFuerZeitfenster, minute: 20 } });
            await request(app).post('/api/slots').send({ ...slotBasis, Abfahrt: { stunde: topfKriterien.AbfahrtStundeFuerZeitfenster, minute: 30 } });
            
            // 2 Slots für KonfliktZone2 erstellen, um maxKapazitaet = floor(0.7*2) = 1 zu erhalten
            const slotBasis2 = { von: "Z", bis: "AA", Abschnitt: topfKriterien2.Abschnitt, Ankunft: { stunde: 16, minute: 0 }, 
                                Verkehrstag: topfKriterien2.Verkehrstag, Kalenderwoche: topfKriterien2.Kalenderwoche, 
                                Verkehrsart: topfKriterien2.Verkehrsart,
                                Grundentgelt: 250 
                            };
            const s2 = await request(app).post('/api/slots').send({ ...slotBasis2, Abfahrt: { stunde: topfKriterien2.AbfahrtStundeFuerZeitfenster, minute: 10 } });
            await request(app).post('/api/slots').send({ ...slotBasis2, Abfahrt: { stunde: topfKriterien2.AbfahrtStundeFuerZeitfenster, minute: 20 } });

            // 3 Slots für KonfliktZone3 erstellen, um maxKapazitaet = floor(0.7*3) = 2 zu erhalten
            const slotBasis3 = { von: "V", bis: "W", Abschnitt: topfKriterien3.Abschnitt, Ankunft: { stunde: 14, minute: 0 }, 
                                Verkehrstag: topfKriterien3.Verkehrstag, Kalenderwoche: topfKriterien3.Kalenderwoche, 
                                Verkehrsart: topfKriterien3.Verkehrsart,
                                Grundentgelt: 50 
                            };
            const s3 = await request(app).post('/api/slots').send({ ...slotBasis3, Abfahrt: { stunde: topfKriterien3.AbfahrtStundeFuerZeitfenster, minute: 10 } });
            await request(app).post('/api/slots').send({ ...slotBasis3, Abfahrt: { stunde: topfKriterien3.AbfahrtStundeFuerZeitfenster, minute: 20 } });
            await request(app).post('/api/slots').send({ ...slotBasis3, Abfahrt: { stunde: topfKriterien3.AbfahrtStundeFuerZeitfenster, minute: 30 } });
            
            
            kt_DetectConflict = await Kapazitaetstopf.findById(s1.body.data.VerweisAufTopf);
            expect(kt_DetectConflict.maxKapazitaet).toBe(2);

            kt_NoConflict = await Kapazitaetstopf.findById(s2.body.data.VerweisAufTopf);
            expect(kt_NoConflict.maxKapazitaet).toBe(1);

            kt_NoConflict2 = await Kapazitaetstopf.findById(s3.body.data.VerweisAufTopf);
            expect(kt_NoConflict2.maxKapazitaet).toBe(2);

            // 2 Anfragen erstellen für KonfliktZone1 und KonfliktZone2
            const anfrageBasis = { Email: "conflict@evu.com", Verkehrsart: "SGV", Verkehrstag: "Sa+So", Zeitraum: { start: "2025-01-06", ende: "2025-01-12" }, Status: 'validiert'}; // KW2 2025
            const anfrageBasis2 = { EVU: "ConflictEVU4", Email: "conflict@evu2.com", Verkehrsart: "SGV", Verkehrstag: "Sa+So", Zeitraum: { start: "2025-01-06", ende: "2025-01-12" }, Status: 'validiert'}; // KW2 2025
            const anfragePromises = [];
            
            anfragePromises.push(new Anfrage({ ...anfrageBasis, EVU: `ConflictEVU1` , Zugnummer: `C1`, ListeGewuenschterSlotAbschnitte: [{von: "Y", bis:"Z", Abfahrtszeit: {stunde:13, minute:10 }, Ankunftszeit:{stunde:14,minute:0}}] }).save());
            anfragePromises.push(new Anfrage({ ...anfrageBasis2, Zugnummer: `C4`, 
                                               ListeGewuenschterSlotAbschnitte: [{von: "Y", bis:"Z", Abfahrtszeit: {stunde:13, minute:10 }, Ankunftszeit:{stunde:14,minute:0}},
                                                                                 {von: "Z", bis:"AA", Abfahrtszeit: {stunde:15, minute:10 }, Ankunftszeit:{stunde:16,minute:0}}
                                               ] }).save());
            const erstellteAnfragen = await Promise.all(anfragePromises);
            anfragenIds = erstellteAnfragen.map(a => a._id);  
            
            // 1 Anfrage erstellen für KonfliktZone3
            let anfrage_A = await new Anfrage({ ...anfrageBasis2, EVU: "ConflictEVU5" , Zugnummer: "C5", 
                                            ListeGewuenschterSlotAbschnitte: [{von: "V", bis:"W", Abfahrtszeit: {stunde:13, minute:10 }, Ankunftszeit:{stunde:14,minute:0}}]
                                        }).save();

            // 3. Zuordnungsprozess für die Anfragen anstoßen -> Erzeugt die Konfliktsituation
            await request(app).post(`/api/anfragen/${anfragenIds[0]._id}/zuordnen`).send();
            await request(app).post(`/api/anfragen/${anfragenIds[1]._id}/zuordnen`).send();
            await request(app).post(`/api/anfragen/${anfrage_A._id}/zuordnen`).send();
            
            //console.log(anfrage4);

            kt_DetectConflict = await Kapazitaetstopf.findById(s1.body.data.VerweisAufTopf);
            expect(kt_DetectConflict.ListeDerAnfragen).toHaveLength(2); // keine Topf-Überbuchung (2 <= maxKap 2), aber ein Slot-Konflikt

            kt_NoConflict = await Kapazitaetstopf.findById(s2.body.data.VerweisAufTopf);
            expect(kt_NoConflict.ListeDerAnfragen).toHaveLength(1); // keine Topf-Überbuchung (1 <= max Kap 1)

            kt_NoConflict2 = await Kapazitaetstopf.findById(s3.body.data.VerweisAufTopf);
            expect(kt_NoConflict2.ListeDerAnfragen).toHaveLength(1); // keine Topf-Überbuchung (1 <= max Kap 2)

            // Anfragen dem Kapazitätstopf zuordnen (manuell für diesen Test)
            //kt_DetectConflict.ListeDerAnfragen = anfragenIds;
            //await kt_DetectConflict.save();

            // Aktion: Konflikterkennung Töpfe anstoßen
            let response = await request(app)
                .post('/api/konflikte/identifiziere-topf-konflikte')
                .send();

            expect(response.status).toBe(200);
            expect(response.body.message).toBe('Konfliktdetektion für Kapazitätstöpfe abgeschlossen.');
            expect(response.body.neuErstellteKonflikte).toHaveLength(0);
            expect(response.body.toepfeOhneKonflikt).toHaveLength(3);

            kt_NoConflict2 = await Kapazitaetstopf.findById(kt_NoConflict2._id);
            let anfrage5 = await Anfrage.findOne({Zugnummer: `C5`});
            expect(kt_NoConflict2.ListeDerAnfragen).toHaveLength(1);
            expect(kt_NoConflict2.ListeDerAnfragen[0]._id.toString()).toBe(anfrage5._id.toString());
            
        });

        it('sollte einen neuen Slot-Konflikt korrekt identifizieren und den Status zugewiesenen Slots ohne Konflikt korrekt setzen', async () => {
            // Aktion: Konflikterkennung anstoßen
            let response = await request(app)
                .post('/api/konflikte/identifiziere-slot-konflikte')
                .send();

            // Überprüfung der Antwort
            expect(response.status).toBe(200);
            expect(response.body.message).toBe('Konfliktdetektion für Slots abgeschlossen.');
            expect(response.body.neuErstellteKonflikte).toHaveLength(1);
            expect(response.body.aktualisierteUndGeoeffneteKonflikte).toHaveLength(0);
            expect(response.body.unveraenderteBestehendeKonflikte).toHaveLength(0);
            expect(response.body.autoGeloesteKonflikte).toHaveLength(0);
            expect(response.body.slotsOhneKonflikt).toHaveLength(7);

            // Anfrage C5 hat überhaupt keinen Konflikt, ist allein im Topf kt_NoConflict2 (1 <= max Kap 2)
            // Sie hat auch keinen Slot-Konflikt und kann daher final bestätigt werden.
            let anfrage5 = await Anfrage.findOne({Zugnummer: `C5`});
            //console.log(anfrage5);
            expect(anfrage5.Status).toBe('vollstaendig_final_bestaetigt');
            expect(anfrage5.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('bestaetigt_slot');

            
        });

        it('sollte einen neuen Slot-Konflikt korrekt identifizieren und ein Konfliktdokument erstellen', async () => {
            // Aktion: Konflikterkennung anstoßen
            const response = await request(app)
                .post('/api/konflikte/identifiziere-slot-konflikte')
                .send();

            // Überprüfung der Antwort
            expect(response.status).toBe(200);
            expect(response.body.message).toBe('Konfliktdetektion für Slots abgeschlossen.');
            expect(response.body.neuErstellteKonflikte).toHaveLength(1);
            expect(response.body.aktualisierteUndGeoeffneteKonflikte).toHaveLength(0);
            expect(response.body.unveraenderteBestehendeKonflikte).toHaveLength(0);
            expect(response.body.autoGeloesteKonflikte).toHaveLength(0);
            expect(response.body.slotsOhneKonflikt).toHaveLength(7);

            const konfliktDokuId = response.body.neuErstellteKonflikte[0].id;

            // Überprüfung des erstellten Konfliktdokuments in der DB
            const konfliktDokuDB = await KonfliktDokumentation.findById(konfliktDokuId);
            
            s1 = await Slot.findById(s1.body.data._id);            
            //console.log(s1);
            expect(konfliktDokuDB).not.toBeNull();
            expect(konfliktDokuDB.ausloesenderSlot.toString()).toBe(s1._id.toString());
            expect(konfliktDokuDB.status).toBe('offen');
            
            // Überprüfe beteiligteAnfragen (Reihenfolge nicht garantiert, daher Set-Vergleich oder Ähnliches)
            const beteiligteAnfragenStringsDB = konfliktDokuDB.beteiligteAnfragen.map(id => id.toString());
            const erwarteteAnfragenStrings = anfragenIds.map(id => id.toString());
            expect(beteiligteAnfragenStringsDB.sort()).toEqual(erwarteteAnfragenStrings.sort());
            expect(beteiligteAnfragenStringsDB).toHaveLength(2);

            //Prüfe Status der Anfragen im Konflikt
            let beteiligteAnfrage = await Anfrage.findById(beteiligteAnfragenStringsDB[0]);
            let anfrage4 = await Anfrage.findOne({Zugnummer: `C4`});
            //console.log(anfrage4);
            expect(beteiligteAnfrage.Status).toBe('in_konfliktloesung_slot');
            expect(beteiligteAnfrage.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('wartet_konflikt_slot');
            beteiligteAnfrage = await Anfrage.findById(beteiligteAnfragenStringsDB[1]);
            expect(beteiligteAnfrage.Status).toBe('in_konfliktloesung_slot');
            expect(beteiligteAnfrage.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('wartet_konflikt_slot');          
            expect(anfrage4.Status).toBe('in_konfliktloesung_slot');
            expect(anfrage4.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('wartet_konflikt_slot');
            expect(anfrage4.ZugewieseneSlots[1].statusEinzelzuweisung).toBe('bestaetigt_slot');
            

            expect(konfliktDokuDB.zugewieseneAnfragen).toEqual([]);
            expect(konfliktDokuDB.abgelehnteAnfragenEntgeltvergleich).toEqual([]);
            // ... etc. für andere leere Listen
        });

        it('sollte ein existierendes offenes Slot-Konfliktdokument nicht neu erstellen, wenn sich die Anfragen nicht geändert haben', async () => {
            // 1. Erste Konflikterkennung (erstellt das Dokument)
            await request(app).post('/api/konflikte/identifiziere-slot-konflikte').send();
            let anzahlKonfliktDokus = await KonfliktDokumentation.countDocuments();
            expect(anzahlKonfliktDokus).toBe(1);
            const ersteKonfliktDoku = await KonfliktDokumentation.findOne({ ausloesenderSlot: s1.body.data._id });
            expect(ersteKonfliktDoku).not.toBeNull();

            // 2. Aktion: Konflikterkennung erneut anstoßen, ohne dass sich etwas geändert hat
            const response = await request(app).post('/api/konflikte/identifiziere-slot-konflikte').send();

            // Überprüfung der Antwort
            //console.log(response.body);
            expect(response.status).toBe(200);
            expect(response.body.neuErstellteKonflikte).toHaveLength(0);
            expect(response.body.aktualisierteUndGeoeffneteKonflikte).toHaveLength(0); // Da die Anfragen gleich blieben
            expect(response.body.unveraenderteBestehendeKonflikte).toHaveLength(1);
            expect(response.body.unveraenderteBestehendeKonflikte[0].id.toString()).toBe(ersteKonfliktDoku._id.toString());
            expect(response.body.autoGeloesteKonflikte).toHaveLength(0);
            expect(response.body.slotsOhneKonflikt).toHaveLength(7);


            // Überprüfung, dass keine neue Konfliktdoku erstellt wurde
            anzahlKonfliktDokus = await KonfliktDokumentation.countDocuments();
            expect(anzahlKonfliktDokus).toBe(1); // Immer noch nur eine

            const konfliktDokuDB_nachZweitemLauf = await KonfliktDokumentation.findById(ersteKonfliktDoku._id);
            expect(konfliktDokuDB_nachZweitemLauf.status).toBe('offen'); // Sollte offen geblieben sein
            // notizen könnten sich durch den zweiten Lauf geändert haben, falls wir das implementieren
        });

        it('sollte einen gelösten Topf-Konflikt zurücksetzen und wieder öffnen, wenn neue Anfragen hinzukommen und den Konflikt verändern', async () => {
            // A. Initialen Konflikt erzeugen und lösen (simuliert)
            // 1. Konflikt identifizieren (erzeugt KonfliktDoku K1)
            const identResponse1 = await request(app).post('/api/konflikte/identifiziere-slot-konflikte').send();
            expect(identResponse1.body.neuErstellteKonflikte).toHaveLength(1);
            const konfliktDokuId = identResponse1.body.neuErstellteKonflikte[0].id;

            // 2. Konflikt K1 lösen, indem 1 von 2 Anfragen verzichten (C4 -> anfragenIds[1])
            const updatePayloadGeloest = {
                ListeAnfragenMitVerzicht: [anfragenIds[1]._id.toString()]
            };
            const loesenResponse = await request(app)
                .put(`/api/konflikte/slot/${konfliktDokuId}/verzicht-verschub`)
                .send(updatePayloadGeloest);
            //console.log(loesenResponse);
            expect(loesenResponse.status).toBe(200);
            expect(loesenResponse.body.data.status).toBe('geloest');
            expect(loesenResponse.body.data.zugewieseneAnfragen).toHaveLength(1); // C1 sollte zugewiesen sein

            // B. Neue Situation schaffen: Eine weitere Anfrage kommt hinzu
            anfrageNeu = await new Anfrage({ EVU: "ReopenEVU", Zugnummer: "R5", Status: 'validiert',
                Email: "reopen@evu.com", Verkehrsart: "SGV", Verkehrstag: "Sa+So", 
                Zeitraum: { start: "2025-01-06", ende: "2025-01-12" }, Entgelt: 200,
                ListeGewuenschterSlotAbschnitte: [{von: "Y", bis:"Z", Abfahrtszeit: {stunde:13, minute:10}, Ankunftszeit:{stunde:14,minute:0}}] }).save();
            //console.log(anfrageNeu);

            await request(app).post(`/api/anfragen/${anfrageNeu._id}/zuordnen`).send();            

            // C. Aktion: Konflikterkennung erneut anstoßen
            const identResponse2 = await request(app)
                .post('/api/konflikte/identifiziere-topf-konflikte')
                .send();
            
            expect(identResponse2.status).toBe(200);
            expect(identResponse2.body.neuErstellteKonflikte).toHaveLength(0); 

            const identResponse3 = await request(app)
                .post('/api/konflikte/identifiziere-slot-konflikte')
                .send();

            // D. Überprüfung
            expect(identResponse3.status).toBe(200);
            expect(identResponse3.body.neuErstellteKonflikte).toHaveLength(0); // Kein neuer Konflikt sollte erstellt werden
            expect(identResponse3.body.aktualisierteUndGeoeffneteKonflikte).toHaveLength(1); // Der bestehende sollte aktualisiert/geöffnet werden
            expect(identResponse3.body.aktualisierteUndGeoeffneteKonflikte[0].id.toString()).toBe(konfliktDokuId.toString());

            const konfliktDoku_final = await KonfliktDokumentation.findById(konfliktDokuId);
            expect(konfliktDoku_final).not.toBeNull();
            expect(konfliktDoku_final.status).toBe('offen'); // Zurück auf 'offen'
            
            // beteiligteAnfragen sollte jetzt alle 3 Anfragen enthalten
            const erwarteteBeteiligteIds = [...anfragenIds.map(a => a._id.toString()), anfrageNeu._id.toString()];
            const tatsaechlicheBeteiligteIds = konfliktDoku_final.beteiligteAnfragen.map(id => id.toString());
            expect(tatsaechlicheBeteiligteIds.sort()).toEqual(erwarteteBeteiligteIds.sort());
            expect(tatsaechlicheBeteiligteIds).toHaveLength(3);

            let anf1 = await Anfrage.findById(erwarteteBeteiligteIds[0]);
            let anf2 = await Anfrage.findById(erwarteteBeteiligteIds[1]);
            let anf3 = await Anfrage.findById(erwarteteBeteiligteIds[2]);

            //console.log(anf1);

            expect(anf1.ZugewieseneSlots).not.toBeNull();
            expect(anf1.ZugewieseneSlots).toHaveLength(1);
            expect(anf1.ZugewieseneSlots[0].statusEinzelzuweisung).toEqual('wartet_konflikt_slot');

            expect(anf2.ZugewieseneSlots).not.toBeNull();
            expect(anf2.ZugewieseneSlots).toHaveLength(2);
            expect(anf2.ZugewieseneSlots[0].statusEinzelzuweisung).toEqual('wartet_konflikt_slot');

            expect(anf3.ZugewieseneSlots).not.toBeNull();
            expect(anf3.ZugewieseneSlots).toHaveLength(1);
            expect(anf3.ZugewieseneSlots[0].statusEinzelzuweisung).toEqual('wartet_konflikt_slot');

            // Resolution-Felder sollten zurückgesetzt sein
            expect(konfliktDoku_final.zugewieseneAnfragen).toEqual([]);
            expect(konfliktDoku_final.ListeAnfragenMitVerzicht).toEqual([]); // Diese werden durch den PUT /api/konflikte/:id gesetzt, nicht durch die reine Detektion
            expect(konfliktDoku_final.abschlussdatum).toBeUndefined(); // Oder null, je nach deiner Reset-Logik im Controller
            expect(konfliktDoku_final.notizen).toContain("neu bewertet/eröffnet");
        });

});

describe('Phasenweise Konfliktlösung PUT /api/konflikte/slot/:konfliktId/...: automatische Zuweisung bei ausreichendem Verzicht in Slot-Konflikt', () => {
    
    let anfragenIds = [];
    let konfliktDokuDB;
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

        

        // 6 Slots für Abschn1 erstellen, um maxKapazitaet = floor(0.7*6) = 4 zu erhalten
        const slotBasis = { von: "Y", bis: "Z", Abschnitt: "Abschn1", 
                                Verkehrstag: "Sa+So", Kalenderwoche: 2, Verkehrsart: "SGV",
                                Grundentgelt: 150 
                            };
        let s1 = await request(app).post('/api/slots').send({ ...slotBasis, Abfahrt: { stunde: 13, minute: 10 }, Ankunft: { stunde: 14, minute: 0 } });
        await request(app).post('/api/slots').send({ ...slotBasis, Abfahrt: { stunde: 13, minute: 20 }, Ankunft: { stunde: 14, minute: 10 } });
        await request(app).post('/api/slots').send({ ...slotBasis, Abfahrt: { stunde: 13, minute: 30 }, Ankunft: { stunde: 14, minute: 20 } });
        await request(app).post('/api/slots').send({ ...slotBasis, Abfahrt: { stunde: 13, minute: 40 }, Ankunft: { stunde: 14, minute: 30 } });
        await request(app).post('/api/slots').send({ ...slotBasis, Abfahrt: { stunde: 13, minute: 50 }, Ankunft: { stunde: 14, minute: 40 } });
        await request(app).post('/api/slots').send({ ...slotBasis, Abfahrt: { stunde: 14, minute: 0 }, Ankunft: { stunde: 14, minute: 50 } });

        let kt_DetectConflict = await Kapazitaetstopf.findById(s1.body.data.VerweisAufTopf);
        expect(kt_DetectConflict.maxKapazitaet).toBe(4);

        const anfrageBasis = { Email: "conflict@evu.com", Verkehrsart: "SGV", Verkehrstag: "Sa+So", Zeitraum: { start: "2025-01-06", ende: "2025-01-12" }, Status: 'validiert'}; // KW2 2025
        const anfragePromises = [];
        
        //4 Anfrage konkurrieren um den gleichen Slot
        anfragePromises.push(new Anfrage({ ...anfrageBasis, EVU: `ConflictEVU1` , Zugnummer: `C1`, ListeGewuenschterSlotAbschnitte: [{von: "Y", bis:"Z", Abfahrtszeit: {stunde:13, minute:10 }, Ankunftszeit:{stunde:14,minute:0}}] }).save());
        anfragePromises.push(new Anfrage({ ...anfrageBasis, EVU: `ConflictEVU2` , Zugnummer: `C2`, ListeGewuenschterSlotAbschnitte: [{von: "Y", bis:"Z", Abfahrtszeit: {stunde:13, minute:10 }, Ankunftszeit:{stunde:14,minute:0}}] }).save());
        anfragePromises.push(new Anfrage({ ...anfrageBasis, EVU: `ConflictEVU3` , Zugnummer: `C3`, ListeGewuenschterSlotAbschnitte: [{von: "Y", bis:"Z", Abfahrtszeit: {stunde:13, minute:10 }, Ankunftszeit:{stunde:14,minute:0}}] }).save());
        anfragePromises.push(new Anfrage({ ...anfrageBasis, EVU: `ConflictEVU4` , Zugnummer: `C4`, ListeGewuenschterSlotAbschnitte: [{von: "Y", bis:"Z", Abfahrtszeit: {stunde:13, minute:10 }, Ankunftszeit:{stunde:14,minute:0}}] }).save());

        const erstellteAnfragen = await Promise.all(anfragePromises);
        anfragenIds = erstellteAnfragen.map(a => a._id);

        await request(app).post(`/api/anfragen/${anfragenIds[0]._id}/zuordnen`).send();
        await request(app).post(`/api/anfragen/${anfragenIds[1]._id}/zuordnen`).send();
        await request(app).post(`/api/anfragen/${anfragenIds[2]._id}/zuordnen`).send();
        await request(app).post(`/api/anfragen/${anfragenIds[3]._id}/zuordnen`).send();

        kt_DetectConflict = await Kapazitaetstopf.findById(s1.body.data.VerweisAufTopf);
        expect(kt_DetectConflict.ListeDerAnfragen).toHaveLength(4); //kein Konflikt 4 Anfragen für 4 Kapazitäten
        
        //Erster Schritt: Topf-Konflikte
        let response = await request(app)
                .post('/api/konflikte/identifiziere-topf-konflikte')
                .send();
        
        // Überprüfung der Antwort
        expect(response.status).toBe(200);
        expect(response.body.message).toBe('Konfliktdetektion für Kapazitätstöpfe abgeschlossen.');
        expect(response.body.neuErstellteKonflikte).toHaveLength(0);
        expect(response.body.toepfeOhneKonflikt).toHaveLength(1);

        //Zweiter Schritt: Slot-Konflikte
        response = await request(app)
                .post('/api/konflikte/identifiziere-slot-konflikte')
                .send();

        // Überprüfung der Antwort
        expect(response.status).toBe(200);
        expect(response.body.message).toBe('Konfliktdetektion für Slots abgeschlossen.');
        expect(response.body.neuErstellteKonflikte).toHaveLength(1);
        expect(response.body.aktualisierteUndGeoeffneteKonflikte).toHaveLength(0);
        expect(response.body.unveraenderteBestehendeKonflikte).toHaveLength(0);
        expect(response.body.autoGeloesteKonflikte).toHaveLength(0);
        expect(response.body.slotsOhneKonflikt).toHaveLength(5);

        const konfliktDokuId = response.body.neuErstellteKonflikte[0].id;

        // Überprüfung des erstellten Konfliktdokuments in der DB
        konfliktDokuDB = await KonfliktDokumentation.findById(konfliktDokuId);
        expect(konfliktDokuDB).not.toBeNull();
        expect(konfliktDokuDB.status).toBe('offen');
    });

    it('sollte Anfragen automatisch zuweisen und Slot-Konflikt lösen, wenn nach Verzicht die Kapazität ausreicht', async () => {
        // Aktion: 3 Anfragen (anfrage1,3,4) verzichtet. Anfrage 2 gewinnt.
            const updatePayload = {
                ListeAnfragenMitVerzicht: [anfragenIds[0].toString(), anfragenIds[2].toString(), anfragenIds[3].toString()],
            };

            const response = await request(app)
                .put(`/api/konflikte/slot/${konfliktDokuDB._id}/verzicht-verschub`) // Neuer Endpunkt für Slot-Konflikte
                .send(updatePayload);

            expect(response.status).toBe(200);
            
            const aktualisierteKonfliktDoku = await KonfliktDokumentation.findById(response.body.data._id);

            // Überprüfung des Konfliktdokuments
            expect(aktualisierteKonfliktDoku.status).toBe('geloest');
            expect(aktualisierteKonfliktDoku.ListeAnfragenMitVerzicht.map(id => id.toString()).sort()).toEqual([anfragenIds[0].toString(), anfragenIds[2].toString(), anfragenIds[3].toString()].sort());
            
            const zugewieseneIdsKonflikt = aktualisierteKonfliktDoku.zugewieseneAnfragen.map(id => id.toString());
            expect(zugewieseneIdsKonflikt).toHaveLength(1);
            expect(zugewieseneIdsKonflikt).toContain(anfragenIds[1].toString());
            expect(aktualisierteKonfliktDoku.abschlussdatum).toBeDefined();

            // Überprüfung der Anfragen-Status und Einzelzuweisungen
            const a1_updated = await Anfrage.findById(anfragenIds[0]).populate('ZugewieseneSlots.slot');
            const a2_updated = await Anfrage.findById(anfragenIds[1]).populate('ZugewieseneSlots.slot');
            const a3_updated = await Anfrage.findById(anfragenIds[2]).populate('ZugewieseneSlots.slot');
            const a4_updated = await Anfrage.findById(anfragenIds[3]).populate('ZugewieseneSlots.slot');
            // console.log(a1_updated);


            expect(a1_updated.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('abgelehnt_slot_verzichtet');          
            expect(a1_updated.Status).toBe('final_abgelehnt'); 

            expect(a2_updated.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('bestaetigt_slot');          
            expect(a2_updated.Status).toBe('vollstaendig_final_bestaetigt'); 

            expect(a3_updated.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('abgelehnt_slot_verzichtet');          
            expect(a3_updated.Status).toBe('final_abgelehnt'); 

            expect(a4_updated.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('abgelehnt_slot_verzichtet');          
            expect(a4_updated.Status).toBe('final_abgelehnt'); 

    });
});