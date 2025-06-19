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
    jest.setTimeout(20000);
    let anfrage_A, anfrage_B, anfrage_C, anfrage_D;
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
        const commonSlotParams1 = {
            von: "Gruppenstadt-A", bis: "Gruppenstadt-B", Abschnitt: "Gruppen-Strecke1",
            Verkehrsart: "SPFV", Abfahrt: { stunde: 9, minute: 0 }, Ankunft: { stunde: 10, minute: 0 },
            Grundentgelt: grundentgelt
        };

        const commonSlotParams2 = {
            von: "Gruppenstadt-B", bis: "Gruppenstadt-C", Abschnitt: "Gruppen-Strecke2",
            Verkehrsart: "SPFV", Abfahrt: { stunde: 10, minute: 0 }, Ankunft: { stunde: 11, minute: 0 },
            Grundentgelt: grundentgelt
        };

        for (let kw = 1; kw <= anzahlWochen; kw++) {
            for (const vt of ["Mo-Fr", "Sa+So"]) {
                // Erstelle 3 Slots pro Topf-Definition, um maxKap=2 zu erhalten
                await request(app).post('/api/slots').send({ ...commonSlotParams1, Kalenderwoche: kw, Verkehrstag: vt });
                await request(app).post('/api/slots').send({ ...commonSlotParams2, Kalenderwoche: kw, Verkehrstag: vt });
                await request(app).post('/api/slots').send({ ...commonSlotParams1, Kalenderwoche: kw, Verkehrstag: vt, Abfahrt: { stunde: 9, minute: 10 }, Ankunft: { stunde: 10, minute: 10 } });
                await request(app).post('/api/slots').send({ ...commonSlotParams2, Kalenderwoche: kw, Verkehrstag: vt, Abfahrt: { stunde: 10, minute: 10 }, Ankunft: { stunde: 11, minute: 10 } });
                await request(app).post('/api/slots').send({ ...commonSlotParams1, Kalenderwoche: kw, Verkehrstag: vt, Abfahrt: { stunde: 9, minute: 20 }, Ankunft: { stunde: 10, minute: 20 } });
                await request(app).post('/api/slots').send({ ...commonSlotParams2, Kalenderwoche: kw, Verkehrstag: vt, Abfahrt: { stunde: 10, minute: 20 }, Ankunft: { stunde: 11, minute: 20 } });                
            }
        }
        erstellteSlots = await Slot.find({});
        expect(erstellteSlots.length).toBe(36); //3 Slots in 3 Wochen auf 2 Abschitten in den 2 Töpfen Mo-Fr und Sa+So sind 36 Slots insgesamt
        const topfCheck = await Kapazitaetstopf.findOne({ Abschnitt: "Gruppen-Strecke1", Kalenderwoche: 1, Verkehrstag: "Mo-Fr" });
        expect(topfCheck.maxKapazitaet).toBe(2); // floor(0.7*3) = 2

        // 2. Vier Anfragen erstellen, die alle "täglich" über 3 Wochen verkehren
        const anfrageZeitraum = {
            start: GLOBAL_KW1_START_DATE_ISO, // Start KW 1
            ende: addDays(parseISO(GLOBAL_KW1_START_DATE_ISO), (anzahlWochen * 7) - 1) // Ende KW 3
        };
        const anfrageBasis = {
            EVU: "GruppenEVU", Email: "gruppe@evu.com", Verkehrsart: "SPFV", Verkehrstag: "täglich",
            ListeGewuenschterSlotAbschnitte: [{ von: "Gruppenstadt-A", bis: "Gruppenstadt-B", Abfahrtszeit: { stunde: 9, minute: 0 }, Ankunftszeit: { stunde: 10, minute: 0 } },
                                              { von: "Gruppenstadt-B", bis: "Gruppenstadt-C", Abfahrtszeit: { stunde: 10, minute: 0 }, Ankunftszeit: { stunde: 11, minute: 0 } }
            ],
            Zeitraum: anfrageZeitraum, Status: "validiert"
        };

        anfrage_A = await new Anfrage({ ...anfrageBasis, Zugnummer: "GA"}).save();
        anfrage_B = await new Anfrage({ ...anfrageBasis, Zugnummer: "GB"}).save();        
        anfrage_C = await new Anfrage({ ...anfrageBasis, Zugnummer: "GC"}).save();        
        anfrage_D = await new Anfrage({ ...anfrageBasis, Zugnummer: "GD"}).save();        

        // 3. Zuordnungsprozess für die Anfragen anstoßen -> Erzeugt die Konfliktsituation
        await request(app).post(`/api/anfragen/${anfrage_A._id}/zuordnen`).send();
        await request(app).post(`/api/anfragen/${anfrage_B._id}/zuordnen`).send();
        await request(app).post(`/api/anfragen/${anfrage_C._id}/zuordnen`).send();
        await request(app).post(`/api/anfragen/${anfrage_D._id}/zuordnen`).send();

        // Entgelt der Anfragen anpassen        
        await request(app).put(`/api/anfragen/${anfrage_A._id}`).send({Entgelt: 1000, Status: 'validiert'}); 
        await request(app).put(`/api/anfragen/${anfrage_B._id}`).send({Entgelt:  900, Status: 'validiert'}); 
        await request(app).put(`/api/anfragen/${anfrage_C._id}`).send({Entgelt:  800, Status: 'validiert'}); 
        await request(app).put(`/api/anfragen/${anfrage_D._id}`).send({Entgelt:  700, Status: 'validiert'});  
        
        anfrage_A = await Anfrage.findById(anfrage_A._id);
        anfrage_A.Status = 'validiert'; anfrage_A.save();
        anfrage_B = await Anfrage.findById(anfrage_B._id);
        anfrage_B.Status = 'validiert'; anfrage_B.save();
        anfrage_C = await Anfrage.findById(anfrage_C._id);
        anfrage_C.Status = 'validiert'; anfrage_C.save();
        anfrage_D = await Anfrage.findById(anfrage_D._id);
        anfrage_D.Status = 'validiert'; anfrage_D.save();

        // 4. Konflikterkennung anstoßen -> Erzeugt die KonfliktDokumentationen und die KonfliktGruppe
        const identResp = await request(app).post('/api/konflikte/identifiziere-topf-konflikte').send();
        expect(identResp.body.neuErstellteKonflikte).toHaveLength(12); //2 Abschnitte, 3 Wochen, Mo-Fr und Sa+So
        erstellteKonfliktDokus = await KonfliktDokumentation.find({});
        //console.log(erstellteKonfliktDokus);
        //let gruppen = await KonfliktGruppe.find({});
        //console.log(gruppen);
    });

    // ----- TEST 1: GRUPPEN-IDENTIFIZIERUNG -----
    it('sollte korrekt eine Konfliktgruppe mit 12 Konflikten und 4 beteiligten Anfragen identifizieren', async () => {
        // Aktion
        const response = await request(app).get('/api/konflikte/gruppen').send();
        //console.log(response.body);

        // Überprüfung
        expect(response.status).toBe(200);
        expect(response.body.data).toHaveLength(1); // Es sollte genau eine Gruppe geben

        const gruppe = response.body.data[0];
        expect(gruppe.konflikteInGruppe).toHaveLength(12);
        expect(gruppe.beteiligteAnfragen).toHaveLength(4);

        const beteiligteIds = gruppe.beteiligteAnfragen.map(a => a._id.toString());
        expect(beteiligteIds).toContain(anfrage_A._id.toString());
        expect(beteiligteIds).toContain(anfrage_B._id.toString());
        expect(beteiligteIds).toContain(anfrage_C._id.toString());
        expect(beteiligteIds).toContain(anfrage_D._id.toString());
    });

    // ----- TEST 2: GRUPPEN-KONFLIKTLÖSUNG (PHASE 1) -----
    it('sollte eine Gruppenentscheidung (Verzicht) korrekt auf alle 12 Konflikte anwenden und diese lösen', async () => {
        // Setup: Holen der gruppenId
        const gruppenResp = await request(app).get('/api/konflikte/gruppen').send();
        //console.log(gruppenResp.body);        
        const konfliktGruppe = await KonfliktGruppe.findOne({ }); // es ist nur 1 Gruppe in der Datenbank
        const gruppenId = konfliktGruppe._id;

        // Aktion: Anfrage B und D verzichten für die gesamte Gruppe
        const updatePayload = {
            konfliktDokumentIds: konfliktGruppe.konflikteInGruppe.map(k => k._id), // Identifiziert die Gruppe
            ListeAnfragenMitVerzicht: [anfrage_B._id.toString(), anfrage_D._id.toString()]
        };

        const loesenResponse = await request(app)
            .put(`/api/konflikte/gruppen/${gruppenId}/verzicht-verschub`)
            .send(updatePayload);

        //console.log(loesenResponse.body);

        // Überprüfung
        expect(loesenResponse.status).toBe(200);
        expect(loesenResponse.body.data.gruppe.status).toBe('vollstaendig_geloest');
        expect(loesenResponse.body.data.zusammenfassung.anzahlKonflikteInGruppe).toBe(12);
        expect(loesenResponse.body.data.zusammenfassung.davonGeloest).toBe(12);
        expect(loesenResponse.body.data.zusammenfassung.davonOffen).toBe(0);
        
        const gruppe_final = await KonfliktGruppe.findById(gruppenId);
        expect(gruppe_final.status).toBe('vollstaendig_geloest');

        // Stichprobenartige Prüfung eines der 6 Konfliktdokumente
        const einKonflikt_final = await KonfliktDokumentation.findById(erstellteKonfliktDokus[2]._id);
        expect(einKonflikt_final.status).toBe('geloest');
        expect(einKonflikt_final.zugewieseneAnfragen).toHaveLength(2);
        const zuewieseneIds = einKonflikt_final.zugewieseneAnfragen.map(a => a._id.toString());
        expect(zuewieseneIds).toContain(anfrage_A._id.toString());
        expect(zuewieseneIds).toContain(anfrage_C._id.toString());        
        expect(einKonflikt_final.ListeAnfragenMitVerzicht).toHaveLength(2);
        const verzichteteIds = einKonflikt_final.ListeAnfragenMitVerzicht.map(a => a._id.toString());
        expect(verzichteteIds).toContain(anfrage_B._id.toString());
        expect(verzichteteIds).toContain(anfrage_D._id.toString()); 

        // Überprüfung des Status von Anfrage B
        const anfrage_B_final = await Anfrage.findById(anfrage_B._id);
        console.log(anfrage_B_final);
        // Da A_B für ALLE ihre 6 Topf-Konflikte einen Verzicht eingetragen hat,
        // sollte ihr Gesamtstatus jetzt "final_abgelehnt" sein.
        expect(anfrage_B_final.Status).toBe('final_abgelehnt'); 
    });

    // ----- TEST 3: GRUPPEN-KONFLIKTLÖSUNG (PHASE 2 Entgeltvergleich mit eindeutigem Ergebnis) -----
    it('sollte eine Gruppenentscheidung (Entgeltvergleich eindeutig) korrekt auf alle 12 Konflikte anwenden und diese lösen', async () => {
        // Setup: Holen der gruppenId
        const gruppenResp = await request(app).get('/api/konflikte/gruppen').send();
        //console.log(gruppenResp.body);        
        const konfliktGruppe = await KonfliktGruppe.findOne({ }); // es ist nur 1 Gruppe in der Datenbank
        const gruppenId = konfliktGruppe._id;

        // Aktion: keine Anfrage verzichtet für die gesamte Gruppe        

        let loesenResponse = await request(app)
            .put(`/api/konflikte/gruppen/${gruppenId}/verzicht-verschub`)
            .send({});

        //console.log(loesenResponse.body);

        // Überprüfung
        expect(loesenResponse.status).toBe(200);
        expect(loesenResponse.body.data.gruppe.status).toBe('in_bearbeitung_entgelt');
        expect(loesenResponse.body.data.zusammenfassung.anzahlKonflikteInGruppe).toBe(12);
        expect(loesenResponse.body.data.zusammenfassung.davonGeloest).toBe(0);
        expect(loesenResponse.body.data.zusammenfassung.davonOffen).toBe(12);
        let einKonflikt_zwischen = await KonfliktDokumentation.findById(erstellteKonfliktDokus[6]._id);
        expect(einKonflikt_zwischen.status).toBe('in_bearbeitung_entgelt');
        expect(einKonflikt_zwischen.beteiligteAnfragen).toHaveLength(4);
        const beteiligteIDs = einKonflikt_zwischen.beteiligteAnfragen.map(a => a._id.toString());
        expect(beteiligteIDs).toContain(anfrage_A._id.toString());
        expect(beteiligteIDs).toContain(anfrage_B._id.toString());
        expect(beteiligteIDs).toContain(anfrage_C._id.toString());
        expect(beteiligteIDs).toContain(anfrage_D._id.toString());

        
        const gruppe_entgelt = await KonfliktGruppe.findById(gruppenId);
        expect(gruppe_entgelt.status).toBe('in_bearbeitung_entgelt');        

        // Aktion: Entgeltvergleich anstoßen        
        loesenResponse = await request(app)
            .put(`/api/konflikte/gruppen/${gruppenId}/entgeltvergleich`)
            .send({});
        
        einKonflikt_zwischen = await KonfliktDokumentation.findById(erstellteKonfliktDokus[6]._id);
        //console.log(einKonflikt_zwischen);
        let anfrage_B_zwischen = await Anfrage.findById(anfrage_B._id);
        //console.log(anfrage_B_zwischen);

        // Überprüfung
        expect(loesenResponse.status).toBe(200);
        expect(loesenResponse.body.data.gruppe.status).toBe('vollstaendig_geloest');
        expect(loesenResponse.body.data.zusammenfassung.anzahlKonflikteInGruppe).toBe(12);
        expect(loesenResponse.body.data.zusammenfassung.davonGeloest).toBe(12);
        expect(loesenResponse.body.data.zusammenfassung.davonOffen).toBe(0);

        const gruppe_final = await KonfliktGruppe.findById(gruppenId);
        expect(gruppe_final.status).toBe('vollstaendig_geloest');

        // Stichprobenartige Prüfung eines der 6 Konfliktdokumente
        const einKonflikt_final = await KonfliktDokumentation.findById(erstellteKonfliktDokus[3]._id);
        expect(einKonflikt_final.status).toBe('geloest');
        expect(einKonflikt_final.zugewieseneAnfragen).toHaveLength(2);
        const zuewieseneIds = einKonflikt_final.zugewieseneAnfragen.map(a => a._id.toString());
        expect(zuewieseneIds).toContain(anfrage_A._id.toString());
        expect(zuewieseneIds).toContain(anfrage_B._id.toString());        
        expect(einKonflikt_final.abgelehnteAnfragenEntgeltvergleich).toHaveLength(2);
        const verzichteteIds = einKonflikt_final.abgelehnteAnfragenEntgeltvergleich.map(a => a._id.toString());
        expect(verzichteteIds).toContain(anfrage_C._id.toString());
        expect(verzichteteIds).toContain(anfrage_D._id.toString());
        expect(einKonflikt_final.abgelehnteAnfragenHoechstpreis).toHaveLength(0); 

        // Überprüfung des Status von Anfrage B
        const anfrage_B_final = await Anfrage.findById(anfrage_B._id);
        // Da B für ALLE ihre 6 Topf-Konflikte gewonnen hat,
        // sollte ihr Gesamtstatus jetzt "vollstaendig_bestaetigt_topf" sein.
        expect(anfrage_B_final.Status).toBe('vollstaendig_bestaetigt_topf'); 
        // Überprüfung des Status von Anfrage C
        const anfrage_C_final = await Anfrage.findById(anfrage_C._id);
        // Da C für ALLE ihre 6 Topf-Konflikte verloren hat,
        // sollte ihr Gesamtstatus jetzt "final_abgelehnt" sein.
        expect(anfrage_C_final.Status).toBe('final_abgelehnt'); 
    });

    // ----- TEST 4: GRUPPEN-KONFLIKTLÖSUNG (PHASE 2 Entgeltvergleich führt zu Höchstpreisverfahren) -----
    it('sollte eine Gruppenentscheidung (Entgeltvergleich Gleichstand) korrekt auf alle 12 Konflikte anwenden und diese als ungelöst markieren', async () => {
        // Setup: Holen der gruppenId
        const gruppenResp = await request(app).get('/api/konflikte/gruppen').send();
        //console.log(gruppenResp.body);        
        const konfliktGruppe = await KonfliktGruppe.findOne({ }); // es ist nur 1 Gruppe in der Datenbank
        const gruppenId = konfliktGruppe._id;

        //Anfrage B und C haben das gleiche Entgelt von 900
        await request(app).put(`/api/anfragen/${anfrage_C._id}`).send({Entgelt:  900, Status: 'validiert'}); 

        // Aktion: keine Anfrage verzichtet für die gesamte Gruppe  
        let loesenResponse = await request(app)
            .put(`/api/konflikte/gruppen/${gruppenId}/verzicht-verschub`)
            .send({});

        //console.log(loesenResponse.body);

        // Überprüfung
        expect(loesenResponse.status).toBe(200);
        expect(loesenResponse.body.data.gruppe.status).toBe('in_bearbeitung_entgelt');
        expect(loesenResponse.body.data.zusammenfassung.anzahlKonflikteInGruppe).toBe(12);
        expect(loesenResponse.body.data.zusammenfassung.davonGeloest).toBe(0);
        expect(loesenResponse.body.data.zusammenfassung.davonOffen).toBe(12);
        let einKonflikt_zwischen = await KonfliktDokumentation.findById(erstellteKonfliktDokus[6]._id);
        expect(einKonflikt_zwischen.status).toBe('in_bearbeitung_entgelt');
        expect(einKonflikt_zwischen.beteiligteAnfragen).toHaveLength(4);
        const beteiligteIDs = einKonflikt_zwischen.beteiligteAnfragen.map(a => a._id.toString());
        expect(beteiligteIDs).toContain(anfrage_A._id.toString());
        expect(beteiligteIDs).toContain(anfrage_B._id.toString());
        expect(beteiligteIDs).toContain(anfrage_C._id.toString());
        expect(beteiligteIDs).toContain(anfrage_D._id.toString());

        
        const gruppe_entgelt = await KonfliktGruppe.findById(gruppenId);
        expect(gruppe_entgelt.status).toBe('in_bearbeitung_entgelt');        

        // Aktion: Entgeltvergleich anstoßen        
        loesenResponse = await request(app)
            .put(`/api/konflikte/gruppen/${gruppenId}/entgeltvergleich`)
            .send({});
        
        einKonflikt_zwischen = await KonfliktDokumentation.findById(erstellteKonfliktDokus[6]._id);
        //console.log(einKonflikt_zwischen);
        let anfrage_B_zwischen = await Anfrage.findById(anfrage_B._id);
        //console.log(anfrage_B_zwischen);

        // Überprüfung
        expect(loesenResponse.status).toBe(200);
        expect(loesenResponse.body.data.gruppe.status).toBe('in_bearbeitung_hoechstpreis');
        expect(loesenResponse.body.data.zusammenfassung.anzahlKonflikteInGruppe).toBe(12);
        expect(loesenResponse.body.data.zusammenfassung.davonGeloest).toBe(0);
        expect(loesenResponse.body.data.zusammenfassung.davonOffen).toBe(12);

        const gruppe_final = await KonfliktGruppe.findById(gruppenId);
        expect(gruppe_final.status).toBe('in_bearbeitung_hoechstpreis');

        // Stichprobenartige Prüfung eines der 6 Konfliktdokumente
        const einKonflikt_final = await KonfliktDokumentation.findById(erstellteKonfliktDokus[3]._id);
        expect(einKonflikt_final.status).toBe('in_bearbeitung_hoechstpreis');
        expect(einKonflikt_final.zugewieseneAnfragen).toHaveLength(1);
        const zuewieseneIds = einKonflikt_final.zugewieseneAnfragen.map(a => a._id.toString());
        expect(zuewieseneIds).toContain(anfrage_A._id.toString());      
        expect(einKonflikt_final.abgelehnteAnfragenEntgeltvergleich).toHaveLength(1);
        const verzichteteIds = einKonflikt_final.abgelehnteAnfragenEntgeltvergleich.map(a => a._id.toString());
        expect(verzichteteIds).toContain(anfrage_D._id.toString());
        expect(einKonflikt_final.abgelehnteAnfragenHoechstpreis).toHaveLength(0);         

        // Überprüfung des Status von Anfrage A
        const anfrage_A_final = await Anfrage.findById(anfrage_A._id);
        // Da B für ALLE ihre 6 Topf-Konflikte gewonnen hat,
        // sollte ihr Gesamtstatus jetzt "vollstaendig_bestaetigt_topf" sein.
        expect(anfrage_A_final.Status).toBe('vollstaendig_bestaetigt_topf');
        // Überprüfung des Status von Anfrage B
        const anfrage_B_final = await Anfrage.findById(anfrage_B._id);
        // Da B für ALLE ihre 6 Topf-Konflikte im Höchstpreisverfahren ist,
        // sollte ihr Gesamtstatus jetzt "in_konfliktloesung_topf" sein.
        expect(anfrage_B_final.Status).toBe('in_konfliktloesung_topf'); 
        // Überprüfung des Status von Anfrage C
        const anfrage_C_final = await Anfrage.findById(anfrage_C._id);
        // Da C für ALLE ihre 6 Topf-Konflikte im Höchstpreisverfahren ist,
        // sollte ihr Gesamtstatus jetzt "in_konfliktloesung_topf" sein.
        expect(anfrage_C_final.Status).toBe('in_konfliktloesung_topf'); 
        // Überprüfung des Status von Anfrage D
        const anfrage_D_final = await Anfrage.findById(anfrage_D._id);
        // Da D für ALLE ihre 6 Topf-Konflikte verloren hat,
        // sollte ihr Gesamtstatus jetzt "final_abgelehnt" sein.
        expect(anfrage_D_final.Status).toBe('final_abgelehnt'); 
    });

    // ----- TEST 5: GRUPPEN-KONFLIKTLÖSUNG (PHASE 3 Durchführung Höchstpreisverfahren) -----
    it('sollte eine Gruppenentscheidung (Höchstpreisverfahren) korrekt auf alle 12 Konflikte anwenden und diese lösen', async () => {
        // Setup: Holen der gruppenId
        const gruppenResp = await request(app).get('/api/konflikte/gruppen').send();
        //console.log(gruppenResp.body);        
        const konfliktGruppe = await KonfliktGruppe.findOne({ }); // es ist nur 1 Gruppe in der Datenbank
        const gruppenId = konfliktGruppe._id;

        //Anfrage B und C haben das gleiche Entgelt von 900
        await request(app).put(`/api/anfragen/${anfrage_C._id}`).send({Entgelt:  900, Status: 'validiert'}); 

        // Aktion: keine Anfrage verzichtet für die gesamte Gruppe  
        let loesenResponse = await request(app)
            .put(`/api/konflikte/gruppen/${gruppenId}/verzicht-verschub`)
            .send({});

        //console.log(loesenResponse.body);

        // Überprüfung
        expect(loesenResponse.status).toBe(200);
        expect(loesenResponse.body.data.gruppe.status).toBe('in_bearbeitung_entgelt');
        expect(loesenResponse.body.data.zusammenfassung.anzahlKonflikteInGruppe).toBe(12);
        expect(loesenResponse.body.data.zusammenfassung.davonGeloest).toBe(0);
        expect(loesenResponse.body.data.zusammenfassung.davonOffen).toBe(12);
        let einKonflikt_zwischen = await KonfliktDokumentation.findById(erstellteKonfliktDokus[6]._id);
        expect(einKonflikt_zwischen.status).toBe('in_bearbeitung_entgelt');
        expect(einKonflikt_zwischen.beteiligteAnfragen).toHaveLength(4);
        const beteiligteIDs = einKonflikt_zwischen.beteiligteAnfragen.map(a => a._id.toString());
        expect(beteiligteIDs).toContain(anfrage_A._id.toString());
        expect(beteiligteIDs).toContain(anfrage_B._id.toString());
        expect(beteiligteIDs).toContain(anfrage_C._id.toString());
        expect(beteiligteIDs).toContain(anfrage_D._id.toString());

        
        const gruppe_entgelt = await KonfliktGruppe.findById(gruppenId);
        expect(gruppe_entgelt.status).toBe('in_bearbeitung_entgelt');        

        // Aktion: Entgeltvergleich anstoßen        
        loesenResponse = await request(app)
            .put(`/api/konflikte/gruppen/${gruppenId}/entgeltvergleich`)
            .send({});        
        

        // Überprüfung
        expect(loesenResponse.status).toBe(200);
        expect(loesenResponse.body.data.gruppe.status).toBe('in_bearbeitung_hoechstpreis');
        expect(loesenResponse.body.data.zusammenfassung.anzahlKonflikteInGruppe).toBe(12);
        expect(loesenResponse.body.data.zusammenfassung.davonGeloest).toBe(0);
        expect(loesenResponse.body.data.zusammenfassung.davonOffen).toBe(12);

        const gruppe_zwischen = await KonfliktGruppe.findById(gruppenId);
        expect(gruppe_zwischen.status).toBe('in_bearbeitung_hoechstpreis');

        // ---- AKTION: Ergebnisse des Höchstpreisverfahrens senden ----
        const hoechstpreisPayload = {
            ListeGeboteHoechstpreis: [
                { anfrage: anfrage_B._id.toString(), gebot: 920 }, // B bietet 920
                { anfrage: anfrage_C._id.toString(), gebot: 950 }  // C bietet 950
            ]
        };

        loesenResponse = await request(app)
            .put(`/api/konflikte/gruppen/${gruppenId}/hoechstpreis-ergebnis`)
            .send(hoechstpreisPayload);

        einKonflikt_zwischen = await KonfliktDokumentation.findById(erstellteKonfliktDokus[6]._id);
        //console.log(einKonflikt_zwischen);
        let anfrage_B_zwischen = await Anfrage.findById(anfrage_B._id);
        //console.log(anfrage_B_zwischen);

        const gruppe_final = await KonfliktGruppe.findById(gruppenId);
        expect(gruppe_final.status).toBe('vollstaendig_geloest');
        
        // Überprüfung
        expect(loesenResponse.status).toBe(200);
        expect(loesenResponse.body.data.gruppe.status).toBe('vollstaendig_geloest');
        expect(loesenResponse.body.data.zusammenfassung.anzahlKonflikteInGruppe).toBe(12);
        expect(loesenResponse.body.data.zusammenfassung.davonGeloest).toBe(12);
        expect(loesenResponse.body.data.zusammenfassung.davonOffen).toBe(0);

        // Stichprobenartige Prüfung eines der 6 Konfliktdokumente
        const einKonflikt_final = await KonfliktDokumentation.findById(erstellteKonfliktDokus[4]._id);
        expect(einKonflikt_final.status).toBe('geloest');
        expect(einKonflikt_final.zugewieseneAnfragen).toHaveLength(2);
        const zuewieseneIds = einKonflikt_final.zugewieseneAnfragen.map(a => a._id.toString());
        expect(zuewieseneIds).toContain(anfrage_A._id.toString());      
        expect(zuewieseneIds).toContain(anfrage_C._id.toString());      
        expect(einKonflikt_final.abgelehnteAnfragenEntgeltvergleich).toHaveLength(1);
        const verzichteteIds = einKonflikt_final.abgelehnteAnfragenEntgeltvergleich.map(a => a._id.toString());
        expect(verzichteteIds).toContain(anfrage_D._id.toString());
        expect(einKonflikt_final.abgelehnteAnfragenHoechstpreis).toHaveLength(1); 
        const hoechtpreisIds = einKonflikt_final.abgelehnteAnfragenHoechstpreis.map(a => a._id.toString());
        expect(hoechtpreisIds).toContain(anfrage_B._id.toString());        

        // Überprüfung des Status von Anfrage A
        const anfrage_A_final = await Anfrage.findById(anfrage_A._id);
        // Da B für ALLE ihre 6 Topf-Konflikte gewonnen hat,
        // sollte ihr Gesamtstatus jetzt "vollstaendig_bestaetigt_topf" sein.
        expect(anfrage_A_final.Status).toBe('vollstaendig_bestaetigt_topf');
        // Überprüfung des Status von Anfrage B
        const anfrage_B_final = await Anfrage.findById(anfrage_B._id);
        // Da B für ALLE ihre 6 Topf-Konflikte im Höchstpreisverfahren ist,
        // sollte ihr Gesamtstatus jetzt "in_konfliktloesung_topf" sein.
        expect(anfrage_B_final.Status).toBe('final_abgelehnt'); 
        // Überprüfung des Status von Anfrage C
        const anfrage_C_final = await Anfrage.findById(anfrage_C._id);
        // Da C für ALLE ihre 6 Topf-Konflikte im Höchstpreisverfahren ist,
        // sollte ihr Gesamtstatus jetzt "in_konfliktloesung_topf" sein.
        expect(anfrage_C_final.Status).toBe('vollstaendig_bestaetigt_topf'); 
        // Überprüfung des Status von Anfrage D
        const anfrage_D_final = await Anfrage.findById(anfrage_D._id);
        // Da D für ALLE ihre 6 Topf-Konflikte verloren hat,
        // sollte ihr Gesamtstatus jetzt "final_abgelehnt" sein.
        expect(anfrage_D_final.Status).toBe('final_abgelehnt'); 
    });
});

describe('Konfliktgruppen-Status-Synchronisation', () => {

        beforeAll(async () => {
            // Mongoose Verbindung herstellen, wenn nicht schon global geschehen
            // Diese Verbindung muss die URI zur Docker-DB nutzen
            await mongoose.connect(process.env.TEST_MONGO_URI || 'mongodb://localhost:27017/test-mongo-slots');
        });
    
        afterAll(async () => {
            await mongoose.disconnect();
        });

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
        });

        it('sollte den Gruppenstatus auf "invalide" setzen, wenn die Einzelkonflikte bei gleicher Kapazität der Töpfe unterschiedliche Status haben', async () => {
            // ---- SETUP: Erzeuge zwei Konflikte mit identischen Anfragen, aber unterschiedlichem Status ----

            const commonSlotParams1 = {
                von: "S", bis: "T", Abschnitt: "Sued",
                Verkehrsart: "SPFV", Abfahrt: { stunde: 9, minute: 0 }, Ankunft: { stunde: 10, minute: 0 },
                Grundentgelt: 150, Verkehrstag: "Mo-Fr"
            };

            for (let kw = 11; kw <= 12; kw++) {
                
                    // Erstelle 2 Slots pro Topf-Definition, um maxKap=1 zu erhalten
                    await request(app).post('/api/slots').send({ ...commonSlotParams1, Kalenderwoche: kw });
                    await request(app).post('/api/slots').send({ ...commonSlotParams1, Kalenderwoche: kw, Abfahrt: { stunde: 9, minute: 10 }, Ankunft: { stunde: 10, minute: 10 } });             
                
            }

            const s1 = await Slot.findOne({Kalenderwoche: 11});
            const s2 = await Slot.findOne({Kalenderwoche: 12});

            // 1. Lade die beiden Kapazitätstöpfe
            const kt_A = await Kapazitaetstopf.findOne({Kalenderwoche: 11});
            const kt_B = await Kapazitaetstopf.findOne({Kalenderwoche: 12});
            
            // 2. Erstelle zwei Anfragen
            await new Anfrage({ Zugnummer: "X1", EVU: "Inv", Verkehrsart: "SPFV", Verkehrstag: "Mo-Fr", Zeitraum: { start: "2025-03-10", ende: "2025-03-23" }, ListeGewuenschterSlotAbschnitte: [{von:"S", bis:"T", Abfahrtszeit:{stunde:9,minute:0}, Ankunftszeit:{stunde:10,minute:0}}], Email: 'rv@evu.de',
            ZugewieseneSlots: [{slot: s1._id, statusEinzelzuweisung: 'wartet_konflikt_topf'}, {slot: s2._id, statusEinzelzuweisung: 'wartet_konflikt_topf'}], Status: 'validiert' }).save();
            await new Anfrage({ Zugnummer: "Y1", EVU: "Inv", Verkehrsart: "SPFV", Verkehrstag: "Mo-Fr", Zeitraum: { start: "2025-03-10", ende: "2025-03-23" }, ListeGewuenschterSlotAbschnitte: [{von:"S", bis:"T", Abfahrtszeit:{stunde:9,minute:0}, Ankunftszeit:{stunde:10,minute:0}}], Email: 'rv@evu.de',
            ZugewieseneSlots: [{slot: s1._id, statusEinzelzuweisung: 'wartet_konflikt_topf'}, {slot: s2._id, statusEinzelzuweisung: 'wartet_konflikt_topf'}], Status: 'validiert'  }).save();

            let anfrage_X = await Anfrage.findOne({Zugnummer: "X1"});
            let anfrage_Y = await Anfrage.findOne({Zugnummer: "Y1"});
            await request(app).post(`/api/anfragen/${anfrage_X._id}/zuordnen`).send();
            await request(app).post(`/api/anfragen/${anfrage_Y._id}/zuordnen`).send();

            anfrage_X = await Anfrage.findById(anfrage_X._id);
            anfrage_X.Status = 'validiert'; anfrage_X.save();
            anfrage_Y = await Anfrage.findById(anfrage_Y._id);
            anfrage_Y.Status = 'validiert'; anfrage_Y.save();
            

            // 3. Erstelle zwei Konfliktdokumente und die eine Gruppe
            let response = await request(app)
                .post('/api/konflikte/identifiziere-topf-konflikte')
                .send();
            
            // ---- ÜBERPRÜFUNG ----
            expect(response.status).toBe(200);

            // Finde die resultierende Gruppe in der DB. Es darf nur eine geben.
            let anzahlGruppen = await KonfliktGruppe.countDocuments();
            expect(anzahlGruppen).toBe(1);

            const kdA = await KonfliktDokumentation.findOne({ausloesenderKapazitaetstopf: kt_A._id});
            const kdB = await KonfliktDokumentation.findOne({ausloesenderKapazitaetstopf: kt_B._id});
            //console.log(kt_A);
            //console.log(kd);
            
            // ---- AKTION: Nur eine der Konflikt-Dokus lösen ----
            // In der Realität würde dieser Aufruf nur für die gesamte Gruppe passieren, nicht einzeln
            response = await request(app)
                .put(`/api/konflikte/${kdA._id}/verzicht-verschub`)
                .send({});
            
            // ---- ÜBERPRÜFUNG ----
            expect(response.status).toBe(200);
            const kd_entgelt = await KonfliktDokumentation.findById(kdA._id);
            expect(kd_entgelt.status).toBe('in_bearbeitung_entgelt');
            

            // 4. Erstelle erneut die Konfliktgruppen 
            response = await request(app)
                .post('/api/konflikte/identifiziere-topf-konflikte')
                .send();
            
            // ---- ÜBERPRÜFUNG ----
            expect(response.status).toBe(200);

            // Finde die resultierende Gruppe in der DB. Es darf nur eine geben.
            anzahlGruppen = await KonfliktGruppe.countDocuments();
            expect(anzahlGruppen).toBe(1);

            const gruppe = await KonfliktGruppe.findOne({ beteiligteAnfragen: anfrage_X._id });
            expect(gruppe).not.toBeNull();

            //console.log(gruppe);

            // Der Status der Gruppe muss 'invalide' sein
            expect(gruppe.status).toBe('invalide');

            // Die Gruppe sollte beide Konfliktdokumente enthalten
            expect(gruppe.konflikteInGruppe).toHaveLength(2);
            const konfliktIdsInGruppe = gruppe.konflikteInGruppe.map(id => id.toString());
            expect(konfliktIdsInGruppe).toContain(kdA._id.toString());
            expect(konfliktIdsInGruppe).toContain(kdB._id.toString());
        });
    });