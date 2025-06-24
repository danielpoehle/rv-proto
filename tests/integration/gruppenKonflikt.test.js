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
    jest.setTimeout(60000);
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
            Email: "gruppe@evu.com", Verkehrsart: "SPFV", Verkehrstag: "täglich",
            ListeGewuenschterSlotAbschnitte: [{ von: "Gruppenstadt-A", bis: "Gruppenstadt-B", Abfahrtszeit: { stunde: 9, minute: 0 }, Ankunftszeit: { stunde: 10, minute: 0 } },
                                              { von: "Gruppenstadt-B", bis: "Gruppenstadt-C", Abfahrtszeit: { stunde: 10, minute: 0 }, Ankunftszeit: { stunde: 11, minute: 0 } }
            ],
            Zeitraum: anfrageZeitraum, Status: "validiert"
        };

        anfrage_A = await new Anfrage({ ...anfrageBasis, EVU: "GruppenEVU1", Zugnummer: "GA"}).save();
        anfrage_B = await new Anfrage({ ...anfrageBasis, EVU: "GruppenEVU2", Zugnummer: "GB"}).save();        
        anfrage_C = await new Anfrage({ ...anfrageBasis, EVU: "GruppenEVU3", Zugnummer: "GC"}).save();        
        anfrage_D = await new Anfrage({ ...anfrageBasis, EVU: "GruppenEVU4", Zugnummer: "GD"}).save();        

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
            await new Anfrage({ Zugnummer: "X1", EVU: "Inv1", Verkehrsart: "SPFV", Verkehrstag: "Mo-Fr", Zeitraum: { start: "2025-03-10", ende: "2025-03-23" }, ListeGewuenschterSlotAbschnitte: [{von:"S", bis:"T", Abfahrtszeit:{stunde:9,minute:0}, Ankunftszeit:{stunde:10,minute:0}}], Email: 'rv@evu.de',
            ZugewieseneSlots: [{slot: s1._id, statusEinzelzuweisung: 'wartet_konflikt_topf'}, {slot: s2._id, statusEinzelzuweisung: 'wartet_konflikt_topf'}], Status: 'validiert' }).save();
            await new Anfrage({ Zugnummer: "Y1", EVU: "Inv2", Verkehrsart: "SPFV", Verkehrstag: "Mo-Fr", Zeitraum: { start: "2025-03-10", ende: "2025-03-23" }, ListeGewuenschterSlotAbschnitte: [{von:"S", bis:"T", Abfahrtszeit:{stunde:9,minute:0}, Ankunftszeit:{stunde:10,minute:0}}], Email: 'rv@evu.de',
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

        it('sollte bei zwei Kapazitätstöpfen mit unterschiedlicher Kapazität bei gleichen Anfragen zwei Gruppen bilden', async () => {
            // ---- SETUP: Erzeuge zwei Konflikte mit identischen Anfragen, aber unterschiedlichem Kapazitäten in den Töpfen ----

            const commonSlotParams1 = {
                von: "S", bis: "T", Abschnitt: "Sued",
                Verkehrsart: "SPFV", Abfahrt: { stunde: 9, minute: 0 }, Ankunft: { stunde: 10, minute: 0 },
                Grundentgelt: 150, Verkehrstag: "Mo-Fr"
            };
            const commonSlotParams2 = {
                von: "X", bis: "S", Abschnitt: "West",
                Verkehrsart: "SPFV", Abfahrt: { stunde: 8, minute: 0 }, Ankunft: { stunde: 8, minute: 45 },
                Grundentgelt: 120, Verkehrstag: "Mo-Fr"
            };

            for (let kw = 11; kw <= 12; kw++) {
                
                    // Erstelle 2 bzw. 3 Slots pro Topf-Definition, um maxKap=1 bzw. =2 zu erhalten
                    await request(app).post('/api/slots').send({ ...commonSlotParams1, Kalenderwoche: kw });
                    await request(app).post('/api/slots').send({ ...commonSlotParams1, Kalenderwoche: kw, Abfahrt: { stunde: 9, minute: 10 }, Ankunft: { stunde: 10, minute: 10 } });  
                    await request(app).post('/api/slots').send({ ...commonSlotParams2, Kalenderwoche: kw });
                    await request(app).post('/api/slots').send({ ...commonSlotParams2, Kalenderwoche: kw, Abfahrt: { stunde: 8, minute:  5 }, Ankunft: { stunde: 8, minute: 50 } });            
                    await request(app).post('/api/slots').send({ ...commonSlotParams2, Kalenderwoche: kw, Abfahrt: { stunde: 8, minute: 10 }, Ankunft: { stunde: 8, minute: 55 } });            
                
            }

            const s1 = await Slot.findOne({Abschnitt: 'West', Kalenderwoche: 11});
            const s2 = await Slot.findOne({Abschnitt: 'Sued', Kalenderwoche: 11});

            // 1. Lade die beiden Kapazitätstöpfe
            const kt_A = await Kapazitaetstopf.findOne({bschnitt: 'West', Kalenderwoche: 11});
            const kt_B = await Kapazitaetstopf.findOne({Kbschnitt: 'Sued', Kalenderwoche: 11});
            
            // 2. Erstelle zwei Anfragen
            await new Anfrage({ Zugnummer: "X1", EVU: "Inv3", Verkehrsart: "SPFV", Verkehrstag: "Mo-Fr", Zeitraum: { start: "2025-03-10", ende: "2025-03-23" }, ListeGewuenschterSlotAbschnitte: [{von:"X", bis:"S", Abfahrtszeit:{stunde:8,minute:0}, Ankunftszeit:{stunde:8,minute:45}}, {von:"S", bis:"T", Abfahrtszeit:{stunde:9,minute:0}, Ankunftszeit:{stunde:10,minute:0}}], Email: 'rv@evu.de',
            ZugewieseneSlots: [{slot: s1._id, statusEinzelzuweisung: 'wartet_konflikt_topf'}, {slot: s2._id, statusEinzelzuweisung: 'wartet_konflikt_topf'}], Status: 'validiert' }).save();
            await new Anfrage({ Zugnummer: "Y1", EVU: "Inv4", Verkehrsart: "SPFV", Verkehrstag: "Mo-Fr", Zeitraum: { start: "2025-03-10", ende: "2025-03-23" }, ListeGewuenschterSlotAbschnitte: [{von:"X", bis:"S", Abfahrtszeit:{stunde:8,minute:0}, Ankunftszeit:{stunde:8,minute:45}}, {von:"S", bis:"T", Abfahrtszeit:{stunde:9,minute:0}, Ankunftszeit:{stunde:10,minute:0}}], Email: 'rv@evu.de',
            ZugewieseneSlots: [{slot: s1._id, statusEinzelzuweisung: 'wartet_konflikt_topf'}, {slot: s2._id, statusEinzelzuweisung: 'wartet_konflikt_topf'}], Status: 'validiert'  }).save();
            await new Anfrage({ Zugnummer: "Z1", EVU: "Inv5", Verkehrsart: "SPFV", Verkehrstag: "Mo-Fr", Zeitraum: { start: "2025-03-10", ende: "2025-03-23" }, ListeGewuenschterSlotAbschnitte: [{von:"X", bis:"S", Abfahrtszeit:{stunde:8,minute:0}, Ankunftszeit:{stunde:8,minute:45}}, {von:"S", bis:"T", Abfahrtszeit:{stunde:9,minute:0}, Ankunftszeit:{stunde:10,minute:0}}], Email: 'rv@evu.de',
            ZugewieseneSlots: [{slot: s1._id, statusEinzelzuweisung: 'wartet_konflikt_topf'}, {slot: s2._id, statusEinzelzuweisung: 'wartet_konflikt_topf'}], Status: 'validiert'  }).save();

            let anfrage_X = await Anfrage.findOne({Zugnummer: "X1"});
            let anfrage_Y = await Anfrage.findOne({Zugnummer: "Y1"});
            let anfrage_Z = await Anfrage.findOne({Zugnummer: "Z1"});
            await request(app).post(`/api/anfragen/${anfrage_X._id}/zuordnen`).send();
            await request(app).post(`/api/anfragen/${anfrage_Y._id}/zuordnen`).send();
            await request(app).post(`/api/anfragen/${anfrage_Z._id}/zuordnen`).send();

            anfrage_X = await Anfrage.findById(anfrage_X._id);
            anfrage_X.Status = 'validiert'; anfrage_X.save();
            anfrage_Y = await Anfrage.findById(anfrage_Y._id);
            anfrage_Y.Status = 'validiert'; anfrage_Y.save();
            anfrage_Z = await Anfrage.findById(anfrage_Z._id);
            anfrage_Z.Status = 'validiert'; anfrage_Z.save();
            

            // 3. Erstelle zwei Konfliktdokumente pro KW und zwei Gruppen, weil die maxKapa beider Töpfe unterschiedlich sind
            let response = await request(app)
                .post('/api/konflikte/identifiziere-topf-konflikte')
                .send();
            
            // ---- ÜBERPRÜFUNG ----
            expect(response.status).toBe(200);

            // Finde die resultierende Gruppe in der DB. Es darf nur eine geben.
            let anzahlGruppen = await KonfliktGruppe.countDocuments();
            expect(anzahlGruppen).toBe(2);
        });

        it('sollte den Status der Gruppe und der Anfragen auch bei mehrmaliger Konfliktanalyse korrekt beibehalten', async () => {
            // ---- SETUP: Erzeuge einen Konflikt mit 2 Kapazitäten und 4 Anfrage, die bis zum Höchstpreis kommen ----

            
            const commonSlotParams2 = {
                von: "X", bis: "S", Abschnitt: "West",
                Verkehrsart: "SPFV", Abfahrt: { stunde: 8, minute: 0 }, Ankunft: { stunde: 8, minute: 45 },
                Grundentgelt: 120, Verkehrstag: "Mo-Fr"
            };

            for (let kw = 11; kw <= 13; kw++) {
                
                    // Erstelle 3 Slots pro Topf-Definition, um maxKap=2 zu erhalten
                    await request(app).post('/api/slots').send({ ...commonSlotParams2, Kalenderwoche: kw });
                    await request(app).post('/api/slots').send({ ...commonSlotParams2, Kalenderwoche: kw, Abfahrt: { stunde: 8, minute:  5 }, Ankunft: { stunde: 8, minute: 50 } });            
                    await request(app).post('/api/slots').send({ ...commonSlotParams2, Kalenderwoche: kw, Abfahrt: { stunde: 8, minute: 10 }, Ankunft: { stunde: 8, minute: 55 } });            
                
            }

            const s11 = await Slot.findOne({Abschnitt: 'West', Kalenderwoche: 11});
            const s12 = await Slot.findOne({Abschnitt: 'West', Kalenderwoche: 12});
            const s13 = await Slot.findOne({Abschnitt: 'West', Kalenderwoche: 13});

            // 1. Lade die drei Kapazitätstöpfe
            const kt_11 = await Kapazitaetstopf.findOne({bschnitt: 'West', Kalenderwoche: 11});
            const kt_12 = await Kapazitaetstopf.findOne({Kbschnitt: 'West', Kalenderwoche: 12});
            const kt_13 = await Kapazitaetstopf.findOne({Kbschnitt: 'West', Kalenderwoche: 13});
            
            // 2. Erstelle 4 Anfragen
            await new Anfrage({ Zugnummer: "X1", EVU: "Inv1", Verkehrsart: "SPFV", Verkehrstag: "Mo-Fr", Zeitraum: { start: "2025-03-10", ende: "2025-03-30" }, ListeGewuenschterSlotAbschnitte: [{von:"X", bis:"S", Abfahrtszeit:{stunde:8,minute:0}, Ankunftszeit:{stunde:8,minute:45}}], Email: 'rv@evu1.de',
            ZugewieseneSlots: [{slot: s11._id, statusEinzelzuweisung: 'wartet_konflikt_topf'}, {slot: s12._id, statusEinzelzuweisung: 'wartet_konflikt_topf'}, {slot: s13._id, statusEinzelzuweisung: 'wartet_konflikt_topf'}], Status: 'validiert' }).save();
            await new Anfrage({ Zugnummer: "Y1", EVU: "Inv2", Verkehrsart: "SPFV", Verkehrstag: "Mo-Fr", Zeitraum: { start: "2025-03-10", ende: "2025-03-23" }, ListeGewuenschterSlotAbschnitte: [{von:"X", bis:"S", Abfahrtszeit:{stunde:8,minute:0}, Ankunftszeit:{stunde:8,minute:45}}], Email: 'rv@evu2.de',
            ZugewieseneSlots: [{slot: s11._id, statusEinzelzuweisung: 'wartet_konflikt_topf'}, {slot: s12._id, statusEinzelzuweisung: 'wartet_konflikt_topf'}], Status: 'validiert'  }).save();
            await new Anfrage({ Zugnummer: "Z1", EVU: "Inv3", Verkehrsart: "SPFV", Verkehrstag: "Mo-Fr", Zeitraum: { start: "2025-03-10", ende: "2025-03-23" }, ListeGewuenschterSlotAbschnitte: [{von:"X", bis:"S", Abfahrtszeit:{stunde:8,minute:0}, Ankunftszeit:{stunde:8,minute:45}}], Email: 'rv@evu3.de',
            ZugewieseneSlots: [{slot: s11._id, statusEinzelzuweisung: 'wartet_konflikt_topf'}, {slot: s12._id, statusEinzelzuweisung: 'wartet_konflikt_topf'}], Status: 'validiert'  }).save();
            await new Anfrage({ Zugnummer: "V1", EVU: "Inv4", Verkehrsart: "SPFV", Verkehrstag: "Mo-Fr", Zeitraum: { start: "2025-03-10", ende: "2025-03-23" }, ListeGewuenschterSlotAbschnitte: [{von:"X", bis:"S", Abfahrtszeit:{stunde:8,minute:0}, Ankunftszeit:{stunde:8,minute:45}}], Email: 'rv@evu4.de',
            ZugewieseneSlots: [{slot: s11._id, statusEinzelzuweisung: 'wartet_konflikt_topf'}, {slot: s12._id, statusEinzelzuweisung: 'wartet_konflikt_topf'}], Status: 'validiert'  }).save();


            let anfrage_X = await Anfrage.findOne({Zugnummer: "X1"});
            let anfrage_Y = await Anfrage.findOne({Zugnummer: "Y1"});
            let anfrage_Z = await Anfrage.findOne({Zugnummer: "Z1"});
            let anfrage_V = await Anfrage.findOne({Zugnummer: "V1"});
            await request(app).post(`/api/anfragen/${anfrage_X._id}/zuordnen`).send();
            await request(app).post(`/api/anfragen/${anfrage_Y._id}/zuordnen`).send();
            await request(app).post(`/api/anfragen/${anfrage_Z._id}/zuordnen`).send();
            await request(app).post(`/api/anfragen/${anfrage_V._id}/zuordnen`).send();

            anfrage_X = await Anfrage.findById(anfrage_X._id);
            anfrage_X.Status = 'validiert'; anfrage_X.save();
            anfrage_Y = await Anfrage.findById(anfrage_Y._id);
            anfrage_Y.Status = 'validiert'; anfrage_Y.save();
            anfrage_Z = await Anfrage.findById(anfrage_Z._id);
            anfrage_Z.Status = 'validiert'; anfrage_Z.save();
            anfrage_V = await Anfrage.findById(anfrage_V._id);
            anfrage_V.Status = 'validiert'; anfrage_V.save();
            

            // 3. Erstelle ein Konfliktdokument pro KW und eine Gruppe, weil die maxKapa beider Töpfe gleich sind
            let response = await request(app)
                .post('/api/konflikte/identifiziere-topf-konflikte')
                .send();
            
            // ---- ÜBERPRÜFUNG ----
            expect(response.status).toBe(200);

            // Finde die resultierende Gruppe in der DB. Es darf nur eine geben.
            let anzahlGruppen = await KonfliktGruppe.countDocuments();
            expect(anzahlGruppen).toBe(1);
            let gruppe = await KonfliktGruppe.findOne({ beteiligteAnfragen: anfrage_X._id });
            expect(gruppe).not.toBeNull();
            expect(gruppe.status).toBe('offen');

            //Prüfe den Status aller Anfragen
            anfrage_X = await Anfrage.findById(anfrage_X._id);
            anfrage_Y = await Anfrage.findById(anfrage_Y._id);
            anfrage_Z = await Anfrage.findById(anfrage_Z._id);
            anfrage_V = await Anfrage.findById(anfrage_V._id);
            expect(anfrage_X.Status).toBe('in_konfliktloesung_topf');
            expect(anfrage_X.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('wartet_konflikt_topf');
            expect(anfrage_X.ZugewieseneSlots[2].statusEinzelzuweisung).toBe('bestaetigt_topf');
            expect(anfrage_Y.Status).toBe('in_konfliktloesung_topf');
            expect(anfrage_Y.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('wartet_konflikt_topf');
            expect(anfrage_Z.Status).toBe('in_konfliktloesung_topf');
            expect(anfrage_Z.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('wartet_konflikt_topf');
            expect(anfrage_V.Status).toBe('in_konfliktloesung_topf');
            expect(anfrage_V.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('wartet_konflikt_topf');

            // 4. Anfrage V vezichtet und danach wird die Konflikterkennung erneut angestoßen und darf nichts verändern
            let loesenResponse = await request(app)
            .put(`/api/konflikte/gruppen/${gruppe._id}/verzicht-verschub`)
            .send({ListeAnfragenMitVerzicht: [anfrage_V._id.toString()]});

            // Überprüfung
            expect(loesenResponse.status).toBe(200);
            gruppe = await KonfliktGruppe.findOne({ beteiligteAnfragen: anfrage_X._id });
            expect(gruppe).not.toBeNull();
            expect(gruppe.status).toBe('in_bearbeitung_entgelt');

            //Prüfe den Status aller Anfragen
            anfrage_X = await Anfrage.findById(anfrage_X._id);
            anfrage_Y = await Anfrage.findById(anfrage_Y._id);
            anfrage_Z = await Anfrage.findById(anfrage_Z._id);
            anfrage_V = await Anfrage.findById(anfrage_V._id);
            expect(anfrage_X.Status).toBe('in_konfliktloesung_topf');
            expect(anfrage_X.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('wartet_entgeltentscheidung_topf');
            expect(anfrage_X.ZugewieseneSlots[2].statusEinzelzuweisung).toBe('bestaetigt_topf');
            expect(anfrage_Y.Status).toBe('in_konfliktloesung_topf');
            expect(anfrage_Y.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('wartet_entgeltentscheidung_topf');
            expect(anfrage_Z.Status).toBe('in_konfliktloesung_topf');
            expect(anfrage_Z.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('wartet_entgeltentscheidung_topf');
            expect(anfrage_V.Status).toBe('final_abgelehnt');
            expect(anfrage_V.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('abgelehnt_topf_verzichtet');

            response = await request(app)
                .post('/api/konflikte/identifiziere-topf-konflikte')
                .send();
            
            // ---- ÜBERPRÜFUNG ----
            expect(response.status).toBe(200);

            anzahlGruppen = await KonfliktGruppe.countDocuments();
            expect(anzahlGruppen).toBe(1);
            gruppe = await KonfliktGruppe.findOne({ beteiligteAnfragen: anfrage_X._id });
            expect(gruppe).not.toBeNull();
            expect(gruppe.status).toBe('in_bearbeitung_entgelt');

            //Prüfe den Status aller Anfragen
            anfrage_X = await Anfrage.findById(anfrage_X._id);
            anfrage_Y = await Anfrage.findById(anfrage_Y._id);
            anfrage_Z = await Anfrage.findById(anfrage_Z._id);
            anfrage_V = await Anfrage.findById(anfrage_V._id);
            expect(anfrage_X.Status).toBe('in_konfliktloesung_topf');
            expect(anfrage_X.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('wartet_entgeltentscheidung_topf');
            expect(anfrage_X.ZugewieseneSlots[2].statusEinzelzuweisung).toBe('bestaetigt_topf');
            expect(anfrage_Y.Status).toBe('in_konfliktloesung_topf');
            expect(anfrage_Y.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('wartet_entgeltentscheidung_topf');
            expect(anfrage_Z.Status).toBe('in_konfliktloesung_topf');
            expect(anfrage_Z.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('wartet_entgeltentscheidung_topf');
            expect(anfrage_V.Status).toBe('final_abgelehnt');
            expect(anfrage_V.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('abgelehnt_topf_verzichtet');

            // 5. Entgeltvergleich anstoßen, der Anfrage X erforgreich zuweist und die beiden verbleibenden 
            // Anfragen in das Höchstpreisverfahren gibt und danach wird die Konflikterkennung erneut angestoßen 
            // und darf nichts verändern     
            loesenResponse = await request(app)
                .put(`/api/konflikte/gruppen/${gruppe._id}/entgeltvergleich`)
                .send({});

            // Überprüfung
            expect(loesenResponse.status).toBe(200);
            gruppe = await KonfliktGruppe.findOne({ beteiligteAnfragen: anfrage_X._id });
            expect(gruppe).not.toBeNull();
            expect(gruppe.status).toBe('in_bearbeitung_hoechstpreis');

            //Prüfe den Status aller Anfragen
            anfrage_X = await Anfrage.findById(anfrage_X._id);
            anfrage_Y = await Anfrage.findById(anfrage_Y._id);
            anfrage_Z = await Anfrage.findById(anfrage_Z._id);
            anfrage_V = await Anfrage.findById(anfrage_V._id);
            expect(anfrage_X.Status).toBe('vollstaendig_bestaetigt_topf');
            expect(anfrage_X.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('bestaetigt_topf_entgelt');
            expect(anfrage_X.ZugewieseneSlots[2].statusEinzelzuweisung).toBe('bestaetigt_topf');
            expect(anfrage_Y.Status).toBe('in_konfliktloesung_topf');
            expect(anfrage_Y.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('wartet_hoechstpreis_topf');
            expect(anfrage_Z.Status).toBe('in_konfliktloesung_topf');
            expect(anfrage_Z.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('wartet_hoechstpreis_topf');
            expect(anfrage_V.Status).toBe('final_abgelehnt');
            expect(anfrage_V.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('abgelehnt_topf_verzichtet');

            response = await request(app)
                .post('/api/konflikte/identifiziere-topf-konflikte')
                .send();

            // ---- ÜBERPRÜFUNG ----
            expect(response.status).toBe(200);

            anzahlGruppen = await KonfliktGruppe.countDocuments();
            expect(anzahlGruppen).toBe(1);
            gruppe = await KonfliktGruppe.findOne({ beteiligteAnfragen: anfrage_X._id });
            expect(gruppe).not.toBeNull();
            expect(gruppe.status).toBe('in_bearbeitung_hoechstpreis');

            //Prüfe den Status aller Anfragen
            anfrage_X = await Anfrage.findById(anfrage_X._id);
            anfrage_Y = await Anfrage.findById(anfrage_Y._id);
            anfrage_Z = await Anfrage.findById(anfrage_Z._id);
            anfrage_V = await Anfrage.findById(anfrage_V._id);
            expect(anfrage_X.Status).toBe('vollstaendig_bestaetigt_topf');
            expect(anfrage_X.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('bestaetigt_topf_entgelt');
            expect(anfrage_X.ZugewieseneSlots[2].statusEinzelzuweisung).toBe('bestaetigt_topf');
            expect(anfrage_Y.Status).toBe('in_konfliktloesung_topf');
            expect(anfrage_Y.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('wartet_hoechstpreis_topf');
            expect(anfrage_Z.Status).toBe('in_konfliktloesung_topf');
            expect(anfrage_Z.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('wartet_hoechstpreis_topf');
            expect(anfrage_V.Status).toBe('final_abgelehnt');
            expect(anfrage_V.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('abgelehnt_topf_verzichtet');

            // 6. Ergebnisse des Höchstpreisverfahrens senden und erneut Konfliktanalyse starten
            const hoechstpreisPayload = {
                ListeGeboteHoechstpreis: [
                    { anfrage: anfrage_Y._id.toString(), gebot: 2500 }, // Y bietet 2500, Z gibt kein Gebot ab
                ]
            };

            loesenResponse = await request(app)
                .put(`/api/konflikte/gruppen/${gruppe._id}/hoechstpreis-ergebnis`)
                .send(hoechstpreisPayload);

            // Überprüfung
            expect(loesenResponse.status).toBe(200);
            gruppe = await KonfliktGruppe.findOne({ beteiligteAnfragen: anfrage_X._id });
            expect(gruppe).not.toBeNull();
            expect(gruppe.status).toBe('vollstaendig_geloest');

            //Prüfe den Status aller Anfragen
            anfrage_X = await Anfrage.findById(anfrage_X._id);
            anfrage_Y = await Anfrage.findById(anfrage_Y._id);
            anfrage_Z = await Anfrage.findById(anfrage_Z._id);
            anfrage_V = await Anfrage.findById(anfrage_V._id);
            expect(anfrage_X.Status).toBe('vollstaendig_bestaetigt_topf');
            expect(anfrage_X.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('bestaetigt_topf_entgelt');
            expect(anfrage_X.ZugewieseneSlots[2].statusEinzelzuweisung).toBe('bestaetigt_topf');
            expect(anfrage_Y.Status).toBe('vollstaendig_bestaetigt_topf');
            expect(anfrage_Y.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('bestaetigt_topf_hoechstpreis');
            expect(anfrage_Z.Status).toBe('final_abgelehnt');
            expect(anfrage_Z.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('abgelehnt_topf_hoechstpreis_kein_gebot');
            expect(anfrage_V.Status).toBe('final_abgelehnt');
            expect(anfrage_V.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('abgelehnt_topf_verzichtet');

            response = await request(app)
                .post('/api/konflikte/identifiziere-topf-konflikte')
                .send();

            // ---- ÜBERPRÜFUNG ----
            expect(response.status).toBe(200);

            anzahlGruppen = await KonfliktGruppe.countDocuments();
            expect(anzahlGruppen).toBe(1);
            gruppe = await KonfliktGruppe.findOne({ beteiligteAnfragen: anfrage_X._id });
            expect(gruppe).not.toBeNull();
            expect(gruppe.status).toBe('vollstaendig_geloest');

            //Prüfe den Status aller Anfragen
            anfrage_X = await Anfrage.findById(anfrage_X._id);
            anfrage_Y = await Anfrage.findById(anfrage_Y._id);
            anfrage_Z = await Anfrage.findById(anfrage_Z._id);
            anfrage_V = await Anfrage.findById(anfrage_V._id);
            expect(anfrage_X.Status).toBe('vollstaendig_bestaetigt_topf');
            expect(anfrage_X.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('bestaetigt_topf_entgelt');
            expect(anfrage_X.ZugewieseneSlots[2].statusEinzelzuweisung).toBe('bestaetigt_topf');
            expect(anfrage_Y.Status).toBe('vollstaendig_bestaetigt_topf');
            expect(anfrage_Y.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('bestaetigt_topf_hoechstpreis');
            expect(anfrage_Z.Status).toBe('final_abgelehnt');
            expect(anfrage_Z.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('abgelehnt_topf_hoechstpreis_kein_gebot');
            expect(anfrage_V.Status).toBe('final_abgelehnt');
            expect(anfrage_V.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('abgelehnt_topf_verzichtet');
        });

        it('sollte den max Marktanteil beim Entgeltvergleich korrekt berücksichtigen Fall 1', async () => {
            // ---- SETUP: Erzeuge einen Konflikt mit 2 Kapazitäten und 4 Anfragen, die bis zum Entgeltvergleich kommen ----

            
            const commonSlotParams2 = {
                von: "X", bis: "S", Abschnitt: "Nord-West",
                Verkehrsart: "SPFV", Abfahrt: { stunde: 8, minute: 0 }, Ankunft: { stunde: 8, minute: 45 },
                Grundentgelt: 120, Verkehrstag: "Mo-Fr"
            };

            for (let kw = 11; kw <= 13; kw++) {
                
                    // Erstelle 3 Slots pro Topf-Definition, um maxKap=2 zu erhalten
                    await request(app).post('/api/slots').send({ ...commonSlotParams2, Kalenderwoche: kw });
                    await request(app).post('/api/slots').send({ ...commonSlotParams2, Kalenderwoche: kw, Abfahrt: { stunde: 8, minute:  5 }, Ankunft: { stunde: 8, minute: 50 } });            
                    await request(app).post('/api/slots').send({ ...commonSlotParams2, Kalenderwoche: kw, Abfahrt: { stunde: 8, minute: 10 }, Ankunft: { stunde: 8, minute: 55 } });            
                
            }

            const s11 = await Slot.findOne({Abschnitt: 'Nord-West', Kalenderwoche: 11});
            const s12 = await Slot.findOne({Abschnitt: 'Nord-West', Kalenderwoche: 12});
            const s13 = await Slot.findOne({Abschnitt: 'Nord-West', Kalenderwoche: 13});

            // 1. Lade die drei Kapazitätstöpfe
            const kt_11 = await Kapazitaetstopf.findOne({bschnitt: 'Nord-West', Kalenderwoche: 11});
            const kt_12 = await Kapazitaetstopf.findOne({Kbschnitt: 'Nord-West', Kalenderwoche: 12});
            const kt_13 = await Kapazitaetstopf.findOne({Kbschnitt: 'Nord-West', Kalenderwoche: 13});
            
            // 2. Erstelle 4 Anfragen
            await new Anfrage({ Zugnummer: "X1", EVU: "Inv1", Verkehrsart: "SPFV", Verkehrstag: "Mo-Fr", Zeitraum: { start: "2025-03-10", ende: "2025-03-30" }, ListeGewuenschterSlotAbschnitte: [{von:"X", bis:"S", Abfahrtszeit:{stunde:8,minute:0}, Ankunftszeit:{stunde:8,minute:45}}], Email: 'rv@evu1.de',
            ZugewieseneSlots: [{slot: s11._id, statusEinzelzuweisung: 'wartet_konflikt_topf'}, {slot: s12._id, statusEinzelzuweisung: 'wartet_konflikt_topf'}, {slot: s13._id, statusEinzelzuweisung: 'wartet_konflikt_topf'}], Status: 'validiert' }).save();
            await new Anfrage({ Zugnummer: "Y1", EVU: "Inv1", Verkehrsart: "SPFV", Verkehrstag: "Mo-Fr", Zeitraum: { start: "2025-03-10", ende: "2025-03-23" }, ListeGewuenschterSlotAbschnitte: [{von:"X", bis:"S", Abfahrtszeit:{stunde:8,minute:0}, Ankunftszeit:{stunde:8,minute:45}}], Email: 'rv@evu2.de',
            ZugewieseneSlots: [{slot: s11._id, statusEinzelzuweisung: 'wartet_konflikt_topf'}, {slot: s12._id, statusEinzelzuweisung: 'wartet_konflikt_topf'}], Status: 'validiert'  }).save();
            await new Anfrage({ Zugnummer: "Z1", EVU: "Inv3", Verkehrsart: "SPFV", Verkehrstag: "Mo-Fr", Zeitraum: { start: "2025-03-10", ende: "2025-03-23" }, ListeGewuenschterSlotAbschnitte: [{von:"X", bis:"S", Abfahrtszeit:{stunde:8,minute:0}, Ankunftszeit:{stunde:8,minute:45}}], Email: 'rv@evu3.de',
            ZugewieseneSlots: [{slot: s11._id, statusEinzelzuweisung: 'wartet_konflikt_topf'}, {slot: s12._id, statusEinzelzuweisung: 'wartet_konflikt_topf'}], Status: 'validiert'  }).save();
            await new Anfrage({ Zugnummer: "V1", EVU: "Inv4", Verkehrsart: "SPFV", Verkehrstag: "Mo-Fr", Zeitraum: { start: "2025-03-11", ende: "2025-03-23" }, ListeGewuenschterSlotAbschnitte: [{von:"X", bis:"S", Abfahrtszeit:{stunde:8,minute:0}, Ankunftszeit:{stunde:8,minute:45}}], Email: 'rv@evu4.de',
            ZugewieseneSlots: [{slot: s11._id, statusEinzelzuweisung: 'wartet_konflikt_topf'}, {slot: s12._id, statusEinzelzuweisung: 'wartet_konflikt_topf'}], Status: 'validiert'  }).save();


            let anfrage_X = await Anfrage.findOne({Zugnummer: "X1"});
            let anfrage_Y = await Anfrage.findOne({Zugnummer: "Y1"});
            let anfrage_Z = await Anfrage.findOne({Zugnummer: "Z1"});
            let anfrage_V = await Anfrage.findOne({Zugnummer: "V1"});
            await request(app).post(`/api/anfragen/${anfrage_X._id}/zuordnen`).send();
            await request(app).post(`/api/anfragen/${anfrage_Y._id}/zuordnen`).send();
            await request(app).post(`/api/anfragen/${anfrage_Z._id}/zuordnen`).send();
            await request(app).post(`/api/anfragen/${anfrage_V._id}/zuordnen`).send();

            anfrage_X = await Anfrage.findById(anfrage_X._id);
            anfrage_X.Status = 'validiert'; anfrage_X.save();
            anfrage_Y = await Anfrage.findById(anfrage_Y._id);
            anfrage_Y.Status = 'validiert'; anfrage_Y.save();
            anfrage_Z = await Anfrage.findById(anfrage_Z._id);
            anfrage_Z.Status = 'validiert'; anfrage_Z.save();
            anfrage_V = await Anfrage.findById(anfrage_V._id);
            anfrage_V.Status = 'validiert'; anfrage_V.save();
            

            // 3. Erstelle ein Konfliktdokument pro KW und eine Gruppe, weil die maxKapa beider Töpfe gleich sind
            let response = await request(app)
                .post('/api/konflikte/identifiziere-topf-konflikte')
                .send();
            
            // ---- ÜBERPRÜFUNG ----
            expect(response.status).toBe(200);

            // Finde die resultierende Gruppe in der DB. Es darf nur eine geben.
            let anzahlGruppen = await KonfliktGruppe.countDocuments();
            expect(anzahlGruppen).toBe(1);
            let gruppe = await KonfliktGruppe.findOne({ beteiligteAnfragen: anfrage_X._id });
            expect(gruppe).not.toBeNull();
            expect(gruppe.status).toBe('offen');

            //Prüfe den Status aller Anfragen und deren Entgelt
            anfrage_X = await Anfrage.findById(anfrage_X._id);
            anfrage_Y = await Anfrage.findById(anfrage_Y._id);
            anfrage_Z = await Anfrage.findById(anfrage_Z._id);
            anfrage_V = await Anfrage.findById(anfrage_V._id);
            expect(anfrage_X.Status).toBe('in_konfliktloesung_topf');
            expect(anfrage_X.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('wartet_konflikt_topf');
            expect(anfrage_X.ZugewieseneSlots[2].statusEinzelzuweisung).toBe('bestaetigt_topf');
            expect(anfrage_Y.Status).toBe('in_konfliktloesung_topf');
            expect(anfrage_Y.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('wartet_konflikt_topf');
            expect(anfrage_Z.Status).toBe('in_konfliktloesung_topf');
            expect(anfrage_Z.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('wartet_konflikt_topf');
            expect(anfrage_V.Status).toBe('in_konfliktloesung_topf');
            expect(anfrage_V.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('wartet_konflikt_topf');
            expect(anfrage_X.Entgelt).toBe(15*120);
            expect(anfrage_Y.Entgelt).toBe(10*120);
            expect(anfrage_Z.Entgelt).toBe(10*120);
            expect(anfrage_V.Entgelt).toBe(9*120);


            // 4. Keine Anfrage vezichtet
            let loesenResponse = await request(app)
            .put(`/api/konflikte/gruppen/${gruppe._id}/verzicht-verschub`)
            .send({});

            // Überprüfung
            expect(loesenResponse.status).toBe(200);
            gruppe = await KonfliktGruppe.findOne({ beteiligteAnfragen: anfrage_X._id });
            expect(gruppe).not.toBeNull();
            expect(gruppe.status).toBe('in_bearbeitung_entgelt');

            //Prüfe den Status aller Anfragen
            anfrage_X = await Anfrage.findById(anfrage_X._id);
            anfrage_Y = await Anfrage.findById(anfrage_Y._id);
            anfrage_Z = await Anfrage.findById(anfrage_Z._id);
            anfrage_V = await Anfrage.findById(anfrage_V._id);
            expect(anfrage_X.Status).toBe('in_konfliktloesung_topf');
            expect(anfrage_X.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('wartet_entgeltentscheidung_topf');
            expect(anfrage_X.ZugewieseneSlots[2].statusEinzelzuweisung).toBe('bestaetigt_topf');
            expect(anfrage_Y.Status).toBe('in_konfliktloesung_topf');
            expect(anfrage_Y.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('wartet_entgeltentscheidung_topf');
            expect(anfrage_Z.Status).toBe('in_konfliktloesung_topf');
            expect(anfrage_Z.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('wartet_entgeltentscheidung_topf');
            expect(anfrage_V.Status).toBe('in_konfliktloesung_topf');
            expect(anfrage_V.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('wartet_entgeltentscheidung_topf');

            // 5. Entgeltvergleich anstoßen, da pro EVU nur max 1 Zuweisung zulässig ist,
            // muss das EVU die Anfrage X vor oder nach Anfrage Y priorisieren. 
            // Weil es Anfrage Y höher als Anfrage X priorisiert, werden Y und Z zugewiesen 
            // und V aufgrund zu niedrigem Entgelt und X aufgrund Marktanteil abgewiesen
            loesenResponse = await request(app)
                .put(`/api/konflikte/gruppen/${gruppe._id}/entgeltvergleich`)
                .send({
                    "evuReihungen": [
                                        {
                                            "evu": "Inv1",
                                            "anfrageIds": [
                                                anfrage_Y._id, // Anfrage mit höchster Priorität für Inv1
                                                anfrage_X._id, // Platz 2 für EVU Inv1
                                            ]
                                        },
                                        {
                                            "evu": "Inv3",
                                            "anfrageIds": [
                                                anfrage_Z._id, // Anfrage mit höchster Priorität für Inv3
                                            ]
                                        },
                                        {
                                            "evu": "Inv4",
                                            "anfrageIds": [
                                                anfrage_V._id, // Anfrage mit höchster Priorität für Inv4
                                            ]
                                        },
                                    ],
                });
            
            // Überprüfung
            expect(loesenResponse.status).toBe(200);
            gruppe = await KonfliktGruppe.findOne({ beteiligteAnfragen: anfrage_X._id });
            expect(gruppe).not.toBeNull();
            

            //Prüfe den Status aller Anfragen
            anfrage_X = await Anfrage.findById(anfrage_X._id);
            anfrage_Y = await Anfrage.findById(anfrage_Y._id);
            anfrage_Z = await Anfrage.findById(anfrage_Z._id);
            anfrage_V = await Anfrage.findById(anfrage_V._id);

            expect(gruppe.status).toBe('vollstaendig_geloest');
            
            expect(anfrage_X.Status).toBe('teilweise_bestaetigt_topf');
            expect(anfrage_X.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('abgelehnt_topf_marktanteil');
            expect(anfrage_X.ZugewieseneSlots[2].statusEinzelzuweisung).toBe('bestaetigt_topf');
            expect(anfrage_Y.Status).toBe('vollstaendig_bestaetigt_topf');
            expect(anfrage_Y.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('bestaetigt_topf_entgelt');
            expect(anfrage_Z.Status).toBe('vollstaendig_bestaetigt_topf');
            expect(anfrage_Z.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('bestaetigt_topf_entgelt');
            expect(anfrage_V.Status).toBe('final_abgelehnt');
            expect(anfrage_V.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('abgelehnt_topf_entgelt');
        });

        it('sollte den max Marktanteil beim Entgeltvergleich korrekt berücksichtigen Fall 2', async () => {
            // ---- SETUP: Erzeuge einen Konflikt mit 2 Kapazitäten und 4 Anfragen, die bis zum Entgeltvergleich kommen ----

            
            const commonSlotParams2 = {
                von: "X", bis: "S", Abschnitt: "Nord-West",
                Verkehrsart: "SPFV", Abfahrt: { stunde: 8, minute: 0 }, Ankunft: { stunde: 8, minute: 45 },
                Grundentgelt: 120, Verkehrstag: "Mo-Fr"
            };

            for (let kw = 11; kw <= 13; kw++) {
                
                    // Erstelle 3 Slots pro Topf-Definition, um maxKap=2 zu erhalten
                    await request(app).post('/api/slots').send({ ...commonSlotParams2, Kalenderwoche: kw });
                    await request(app).post('/api/slots').send({ ...commonSlotParams2, Kalenderwoche: kw, Abfahrt: { stunde: 8, minute:  5 }, Ankunft: { stunde: 8, minute: 50 } });            
                    await request(app).post('/api/slots').send({ ...commonSlotParams2, Kalenderwoche: kw, Abfahrt: { stunde: 8, minute: 10 }, Ankunft: { stunde: 8, minute: 55 } });            
                
            }

            const s11 = await Slot.findOne({Abschnitt: 'Nord-West', Kalenderwoche: 11});
            const s12 = await Slot.findOne({Abschnitt: 'Nord-West', Kalenderwoche: 12});
            const s13 = await Slot.findOne({Abschnitt: 'Nord-West', Kalenderwoche: 13});

            // 1. Lade die drei Kapazitätstöpfe
            const kt_11 = await Kapazitaetstopf.findOne({bschnitt: 'Nord-West', Kalenderwoche: 11});
            const kt_12 = await Kapazitaetstopf.findOne({Kbschnitt: 'Nord-West', Kalenderwoche: 12});
            const kt_13 = await Kapazitaetstopf.findOne({Kbschnitt: 'Nord-West', Kalenderwoche: 13});
            
            // 2. Erstelle 4 Anfragen
            await new Anfrage({ Zugnummer: "X1", EVU: "Inv1", Verkehrsart: "SPFV", Verkehrstag: "Mo-Fr", Zeitraum: { start: "2025-03-10", ende: "2025-03-30" }, ListeGewuenschterSlotAbschnitte: [{von:"X", bis:"S", Abfahrtszeit:{stunde:8,minute:0}, Ankunftszeit:{stunde:8,minute:45}}], Email: 'rv@evu1.de',
            ZugewieseneSlots: [{slot: s11._id, statusEinzelzuweisung: 'wartet_konflikt_topf'}, {slot: s12._id, statusEinzelzuweisung: 'wartet_konflikt_topf'}, {slot: s13._id, statusEinzelzuweisung: 'wartet_konflikt_topf'}], Status: 'validiert' }).save();
            await new Anfrage({ Zugnummer: "Y1", EVU: "Inv3", Verkehrsart: "SPFV", Verkehrstag: "Mo-Fr", Zeitraum: { start: "2025-03-10", ende: "2025-03-23" }, ListeGewuenschterSlotAbschnitte: [{von:"X", bis:"S", Abfahrtszeit:{stunde:8,minute:0}, Ankunftszeit:{stunde:8,minute:45}}], Email: 'rv@evu2.de',
            ZugewieseneSlots: [{slot: s11._id, statusEinzelzuweisung: 'wartet_konflikt_topf'}, {slot: s12._id, statusEinzelzuweisung: 'wartet_konflikt_topf'}], Status: 'validiert'  }).save();
            await new Anfrage({ Zugnummer: "Z1", EVU: "Inv3", Verkehrsart: "SPFV", Verkehrstag: "Mo-Fr", Zeitraum: { start: "2025-03-10", ende: "2025-03-23" }, ListeGewuenschterSlotAbschnitte: [{von:"X", bis:"S", Abfahrtszeit:{stunde:8,minute:0}, Ankunftszeit:{stunde:8,minute:45}}], Email: 'rv@evu3.de',
            ZugewieseneSlots: [{slot: s11._id, statusEinzelzuweisung: 'wartet_konflikt_topf'}, {slot: s12._id, statusEinzelzuweisung: 'wartet_konflikt_topf'}], Status: 'validiert'  }).save();
            await new Anfrage({ Zugnummer: "V1", EVU: "Inv4", Verkehrsart: "SPFV", Verkehrstag: "Mo-Fr", Zeitraum: { start: "2025-03-11", ende: "2025-03-23" }, ListeGewuenschterSlotAbschnitte: [{von:"X", bis:"S", Abfahrtszeit:{stunde:8,minute:0}, Ankunftszeit:{stunde:8,minute:45}}], Email: 'rv@evu4.de',
            ZugewieseneSlots: [{slot: s11._id, statusEinzelzuweisung: 'wartet_konflikt_topf'}, {slot: s12._id, statusEinzelzuweisung: 'wartet_konflikt_topf'}], Status: 'validiert'  }).save();


            let anfrage_X = await Anfrage.findOne({Zugnummer: "X1"});
            let anfrage_Y = await Anfrage.findOne({Zugnummer: "Y1"});
            let anfrage_Z = await Anfrage.findOne({Zugnummer: "Z1"});
            let anfrage_V = await Anfrage.findOne({Zugnummer: "V1"});
            await request(app).post(`/api/anfragen/${anfrage_X._id}/zuordnen`).send();
            await request(app).post(`/api/anfragen/${anfrage_Y._id}/zuordnen`).send();
            await request(app).post(`/api/anfragen/${anfrage_Z._id}/zuordnen`).send();
            await request(app).post(`/api/anfragen/${anfrage_V._id}/zuordnen`).send();

            anfrage_X = await Anfrage.findById(anfrage_X._id);
            anfrage_X.Status = 'validiert'; anfrage_X.save();
            anfrage_Y = await Anfrage.findById(anfrage_Y._id);
            anfrage_Y.Status = 'validiert'; anfrage_Y.save();
            anfrage_Z = await Anfrage.findById(anfrage_Z._id);
            anfrage_Z.Status = 'validiert'; anfrage_Z.save();
            anfrage_V = await Anfrage.findById(anfrage_V._id);
            anfrage_V.Status = 'validiert'; anfrage_V.save();
            

            // 3. Erstelle ein Konfliktdokument pro KW und eine Gruppe, weil die maxKapa beider Töpfe gleich sind
            let response = await request(app)
                .post('/api/konflikte/identifiziere-topf-konflikte')
                .send();
            
            // ---- ÜBERPRÜFUNG ----
            expect(response.status).toBe(200);

            // Finde die resultierende Gruppe in der DB. Es darf nur eine geben.
            let anzahlGruppen = await KonfliktGruppe.countDocuments();
            expect(anzahlGruppen).toBe(1);
            let gruppe = await KonfliktGruppe.findOne({ beteiligteAnfragen: anfrage_X._id });
            expect(gruppe).not.toBeNull();
            expect(gruppe.status).toBe('offen');

            //Prüfe den Status aller Anfragen und deren Entgelt
            anfrage_X = await Anfrage.findById(anfrage_X._id);
            anfrage_Y = await Anfrage.findById(anfrage_Y._id);
            anfrage_Z = await Anfrage.findById(anfrage_Z._id);
            anfrage_V = await Anfrage.findById(anfrage_V._id);
            expect(anfrage_X.Status).toBe('in_konfliktloesung_topf');
            expect(anfrage_X.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('wartet_konflikt_topf');
            expect(anfrage_X.ZugewieseneSlots[2].statusEinzelzuweisung).toBe('bestaetigt_topf');
            expect(anfrage_Y.Status).toBe('in_konfliktloesung_topf');
            expect(anfrage_Y.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('wartet_konflikt_topf');
            expect(anfrage_Z.Status).toBe('in_konfliktloesung_topf');
            expect(anfrage_Z.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('wartet_konflikt_topf');
            expect(anfrage_V.Status).toBe('in_konfliktloesung_topf');
            expect(anfrage_V.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('wartet_konflikt_topf');
            expect(anfrage_X.Entgelt).toBe(15*120);
            expect(anfrage_Y.Entgelt).toBe(10*120);
            expect(anfrage_Z.Entgelt).toBe(10*120);
            expect(anfrage_V.Entgelt).toBe(9*120);


            // 4. Keine Anfrage vezichtet
            let loesenResponse = await request(app)
            .put(`/api/konflikte/gruppen/${gruppe._id}/verzicht-verschub`)
            .send({});

            // Überprüfung
            expect(loesenResponse.status).toBe(200);
            gruppe = await KonfliktGruppe.findOne({ beteiligteAnfragen: anfrage_X._id });
            expect(gruppe).not.toBeNull();
            expect(gruppe.status).toBe('in_bearbeitung_entgelt');

            //Prüfe den Status aller Anfragen
            anfrage_X = await Anfrage.findById(anfrage_X._id);
            anfrage_Y = await Anfrage.findById(anfrage_Y._id);
            anfrage_Z = await Anfrage.findById(anfrage_Z._id);
            anfrage_V = await Anfrage.findById(anfrage_V._id);
            expect(anfrage_X.Status).toBe('in_konfliktloesung_topf');
            expect(anfrage_X.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('wartet_entgeltentscheidung_topf');
            expect(anfrage_X.ZugewieseneSlots[2].statusEinzelzuweisung).toBe('bestaetigt_topf');
            expect(anfrage_Y.Status).toBe('in_konfliktloesung_topf');
            expect(anfrage_Y.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('wartet_entgeltentscheidung_topf');
            expect(anfrage_Z.Status).toBe('in_konfliktloesung_topf');
            expect(anfrage_Z.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('wartet_entgeltentscheidung_topf');
            expect(anfrage_V.Status).toBe('in_konfliktloesung_topf');
            expect(anfrage_V.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('wartet_entgeltentscheidung_topf');

            // 5. Entgeltvergleich anstoßen. Da pro EVU nur max 1 Zuweisung zulässig ist,
            // muss das EVU 3 die Anfrage Z vor oder nach Anfrage Y priorisieren. 
            // Weil es Anfrage Z höher als Anfrage Y priorisiert, werden X und Z zugewiesen 
            // und V aufgrund zu niedrigem Entgelt und Y aufgrund Marktanteil abgewiesen
            loesenResponse = await request(app)
                .put(`/api/konflikte/gruppen/${gruppe._id}/entgeltvergleich`)
                .send({
                    "evuReihungen": [
                                        {
                                            "evu": "Inv1",
                                            "anfrageIds": [
                                                anfrage_X._id, // Anfrage mit höchster Priorität für Inv1
                                            ]
                                        },
                                        {
                                            "evu": "Inv3",
                                            "anfrageIds": [
                                                anfrage_Z._id, // Anfrage mit höchster Priorität für Inv3
                                                anfrage_Y._id, // Platz 2 für Inv3
                                            ]
                                        },
                                        {
                                            "evu": "Inv4",
                                            "anfrageIds": [
                                                anfrage_V._id, // Anfrage mit höchster Priorität für Inv4
                                            ]
                                        },
                                    ],
                });
            
            // Überprüfung
            expect(loesenResponse.status).toBe(200);
            gruppe = await KonfliktGruppe.findOne({ beteiligteAnfragen: anfrage_X._id });
            expect(gruppe).not.toBeNull();
            
            //Prüfe den Status aller Anfragen
            anfrage_X = await Anfrage.findById(anfrage_X._id);
            anfrage_Y = await Anfrage.findById(anfrage_Y._id);
            anfrage_Z = await Anfrage.findById(anfrage_Z._id);
            anfrage_V = await Anfrage.findById(anfrage_V._id);

            expect(gruppe.status).toBe('vollstaendig_geloest');
            
            expect(anfrage_X.Status).toBe('vollstaendig_bestaetigt_topf');
            expect(anfrage_X.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('bestaetigt_topf_entgelt');
            expect(anfrage_X.ZugewieseneSlots[2].statusEinzelzuweisung).toBe('bestaetigt_topf');
            expect(anfrage_Y.Status).toBe('final_abgelehnt');
            expect(anfrage_Y.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('abgelehnt_topf_marktanteil');
            expect(anfrage_Z.Status).toBe('vollstaendig_bestaetigt_topf');
            expect(anfrage_Z.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('bestaetigt_topf_entgelt');
            expect(anfrage_V.Status).toBe('final_abgelehnt');
            expect(anfrage_V.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('abgelehnt_topf_entgelt');
        });

        it('sollte den max Marktanteil beim Entgeltvergleich korrekt berücksichtigen Fall 3', async () => {
            // ---- SETUP: Erzeuge einen Konflikt mit 2 Kapazitäten und 4 Anfragen, die bis zum Entgeltvergleich kommen ----

            
            const commonSlotParams2 = {
                von: "X", bis: "S", Abschnitt: "Nord-West",
                Verkehrsart: "SPFV", Abfahrt: { stunde: 8, minute: 0 }, Ankunft: { stunde: 8, minute: 45 },
                Grundentgelt: 120, Verkehrstag: "Mo-Fr"
            };

            for (let kw = 11; kw <= 13; kw++) {
                
                    // Erstelle 3 Slots pro Topf-Definition, um maxKap=2 zu erhalten
                    await request(app).post('/api/slots').send({ ...commonSlotParams2, Kalenderwoche: kw });
                    await request(app).post('/api/slots').send({ ...commonSlotParams2, Kalenderwoche: kw, Abfahrt: { stunde: 8, minute:  5 }, Ankunft: { stunde: 8, minute: 50 } });            
                    await request(app).post('/api/slots').send({ ...commonSlotParams2, Kalenderwoche: kw, Abfahrt: { stunde: 8, minute: 10 }, Ankunft: { stunde: 8, minute: 55 } });            
                
            }

            const s11 = await Slot.findOne({Abschnitt: 'Nord-West', Kalenderwoche: 11});
            const s12 = await Slot.findOne({Abschnitt: 'Nord-West', Kalenderwoche: 12});
            const s13 = await Slot.findOne({Abschnitt: 'Nord-West', Kalenderwoche: 13});

            // 1. Lade die drei Kapazitätstöpfe
            const kt_11 = await Kapazitaetstopf.findOne({bschnitt: 'Nord-West', Kalenderwoche: 11});
            const kt_12 = await Kapazitaetstopf.findOne({Kbschnitt: 'Nord-West', Kalenderwoche: 12});
            const kt_13 = await Kapazitaetstopf.findOne({Kbschnitt: 'Nord-West', Kalenderwoche: 13});
            
            // 2. Erstelle 4 Anfragen
            await new Anfrage({ Zugnummer: "X1", EVU: "Inv1", Verkehrsart: "SPFV", Verkehrstag: "Mo-Fr", Zeitraum: { start: "2025-03-10", ende: "2025-03-30" }, ListeGewuenschterSlotAbschnitte: [{von:"X", bis:"S", Abfahrtszeit:{stunde:8,minute:0}, Ankunftszeit:{stunde:8,minute:45}}], Email: 'rv@evu1.de',
            ZugewieseneSlots: [{slot: s11._id, statusEinzelzuweisung: 'wartet_konflikt_topf'}, {slot: s12._id, statusEinzelzuweisung: 'wartet_konflikt_topf'}, {slot: s13._id, statusEinzelzuweisung: 'wartet_konflikt_topf'}], Status: 'validiert' }).save();
            await new Anfrage({ Zugnummer: "Y1", EVU: "Inv2", Verkehrsart: "SPFV", Verkehrstag: "Mo-Fr", Zeitraum: { start: "2025-03-10", ende: "2025-03-23" }, ListeGewuenschterSlotAbschnitte: [{von:"X", bis:"S", Abfahrtszeit:{stunde:8,minute:0}, Ankunftszeit:{stunde:8,minute:45}}], Email: 'rv@evu2.de',
            ZugewieseneSlots: [{slot: s11._id, statusEinzelzuweisung: 'wartet_konflikt_topf'}, {slot: s12._id, statusEinzelzuweisung: 'wartet_konflikt_topf'}], Status: 'validiert'  }).save();
            await new Anfrage({ Zugnummer: "Z1", EVU: "Inv2", Verkehrsart: "SPFV", Verkehrstag: "Mo-Fr", Zeitraum: { start: "2025-03-10", ende: "2025-03-23" }, ListeGewuenschterSlotAbschnitte: [{von:"X", bis:"S", Abfahrtszeit:{stunde:8,minute:0}, Ankunftszeit:{stunde:8,minute:45}}], Email: 'rv@evu3.de',
            ZugewieseneSlots: [{slot: s11._id, statusEinzelzuweisung: 'wartet_konflikt_topf'}, {slot: s12._id, statusEinzelzuweisung: 'wartet_konflikt_topf'}], Status: 'validiert'  }).save();
            await new Anfrage({ Zugnummer: "V1", EVU: "Inv1", Verkehrsart: "SPFV", Verkehrstag: "Mo-Fr", Zeitraum: { start: "2025-03-11", ende: "2025-03-23" }, ListeGewuenschterSlotAbschnitte: [{von:"X", bis:"S", Abfahrtszeit:{stunde:8,minute:0}, Ankunftszeit:{stunde:8,minute:45}}], Email: 'rv@evu4.de',
            ZugewieseneSlots: [{slot: s11._id, statusEinzelzuweisung: 'wartet_konflikt_topf'}, {slot: s12._id, statusEinzelzuweisung: 'wartet_konflikt_topf'}], Status: 'validiert'  }).save();


            let anfrage_X = await Anfrage.findOne({Zugnummer: "X1"});
            let anfrage_Y = await Anfrage.findOne({Zugnummer: "Y1"});
            let anfrage_Z = await Anfrage.findOne({Zugnummer: "Z1"});
            let anfrage_V = await Anfrage.findOne({Zugnummer: "V1"});
            await request(app).post(`/api/anfragen/${anfrage_X._id}/zuordnen`).send();
            await request(app).post(`/api/anfragen/${anfrage_Y._id}/zuordnen`).send();
            await request(app).post(`/api/anfragen/${anfrage_Z._id}/zuordnen`).send();
            await request(app).post(`/api/anfragen/${anfrage_V._id}/zuordnen`).send();

            anfrage_X = await Anfrage.findById(anfrage_X._id);
            anfrage_X.Status = 'validiert'; anfrage_X.save();
            anfrage_Y = await Anfrage.findById(anfrage_Y._id);
            anfrage_Y.Status = 'validiert'; anfrage_Y.save();
            anfrage_Z = await Anfrage.findById(anfrage_Z._id);
            anfrage_Z.Status = 'validiert'; anfrage_Z.save();
            anfrage_V = await Anfrage.findById(anfrage_V._id);
            anfrage_V.Status = 'validiert'; anfrage_V.save();
            

            // 3. Erstelle ein Konfliktdokument pro KW und eine Gruppe, weil die maxKapa beider Töpfe gleich sind
            let response = await request(app)
                .post('/api/konflikte/identifiziere-topf-konflikte')
                .send();
            
            // ---- ÜBERPRÜFUNG ----
            expect(response.status).toBe(200);

            // Finde die resultierende Gruppe in der DB. Es darf nur eine geben.
            let anzahlGruppen = await KonfliktGruppe.countDocuments();
            expect(anzahlGruppen).toBe(1);
            let gruppe = await KonfliktGruppe.findOne({ beteiligteAnfragen: anfrage_X._id });
            expect(gruppe).not.toBeNull();
            expect(gruppe.status).toBe('offen');

            //Prüfe den Status aller Anfragen und deren Entgelt
            anfrage_X = await Anfrage.findById(anfrage_X._id);
            anfrage_Y = await Anfrage.findById(anfrage_Y._id);
            anfrage_Z = await Anfrage.findById(anfrage_Z._id);
            anfrage_V = await Anfrage.findById(anfrage_V._id);
            expect(anfrage_X.Status).toBe('in_konfliktloesung_topf');
            expect(anfrage_X.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('wartet_konflikt_topf');
            expect(anfrage_X.ZugewieseneSlots[2].statusEinzelzuweisung).toBe('bestaetigt_topf');
            expect(anfrage_Y.Status).toBe('in_konfliktloesung_topf');
            expect(anfrage_Y.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('wartet_konflikt_topf');
            expect(anfrage_Z.Status).toBe('in_konfliktloesung_topf');
            expect(anfrage_Z.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('wartet_konflikt_topf');
            expect(anfrage_V.Status).toBe('in_konfliktloesung_topf');
            expect(anfrage_V.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('wartet_konflikt_topf');
            expect(anfrage_X.Entgelt).toBe(15*120);
            expect(anfrage_Y.Entgelt).toBe(10*120);
            expect(anfrage_Z.Entgelt).toBe(10*120);
            expect(anfrage_V.Entgelt).toBe(9*120);


            // 4. Keine Anfrage vezichtet
            let loesenResponse = await request(app)
            .put(`/api/konflikte/gruppen/${gruppe._id}/verzicht-verschub`)
            .send({});

            // Überprüfung
            expect(loesenResponse.status).toBe(200);
            gruppe = await KonfliktGruppe.findOne({ beteiligteAnfragen: anfrage_X._id });
            expect(gruppe).not.toBeNull();
            expect(gruppe.status).toBe('in_bearbeitung_entgelt');

            //Prüfe den Status aller Anfragen
            anfrage_X = await Anfrage.findById(anfrage_X._id);
            anfrage_Y = await Anfrage.findById(anfrage_Y._id);
            anfrage_Z = await Anfrage.findById(anfrage_Z._id);
            anfrage_V = await Anfrage.findById(anfrage_V._id);
            expect(anfrage_X.Status).toBe('in_konfliktloesung_topf');
            expect(anfrage_X.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('wartet_entgeltentscheidung_topf');
            expect(anfrage_X.ZugewieseneSlots[2].statusEinzelzuweisung).toBe('bestaetigt_topf');
            expect(anfrage_Y.Status).toBe('in_konfliktloesung_topf');
            expect(anfrage_Y.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('wartet_entgeltentscheidung_topf');
            expect(anfrage_Z.Status).toBe('in_konfliktloesung_topf');
            expect(anfrage_Z.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('wartet_entgeltentscheidung_topf');
            expect(anfrage_V.Status).toBe('in_konfliktloesung_topf');
            expect(anfrage_V.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('wartet_entgeltentscheidung_topf');

            // 5. Entgeltvergleich anstoßen. Da pro EVU nur max 1 Zuweisung zulässig ist,
            // muss das EVU 1 und EVU 2 die Anfragen  priorisieren. 
            // Weil Anfrage V höher als Anfrage X priorisiert und Anfrage Z höher als Y, 
            // werden V und Z zugewiesen 
            // und Y und X aufgrund Marktanteil abgewiesen
            loesenResponse = await request(app)
                .put(`/api/konflikte/gruppen/${gruppe._id}/entgeltvergleich`)
                .send({
                    "evuReihungen": [
                                        {
                                            "evu": "Inv1",
                                            "anfrageIds": [
                                                anfrage_V._id, // Anfrage mit höchster Priorität für Inv1
                                                anfrage_X._id, // Platz 2 für Inv1
                                            ]
                                        },
                                        {
                                            "evu": "Inv2",
                                            "anfrageIds": [
                                                anfrage_Z._id, // Anfrage mit höchster Priorität für Inv2
                                                anfrage_Y._id, // Platz 2 für Inv3
                                            ]
                                        },
                                    ],
                });
            
            // Überprüfung
            expect(loesenResponse.status).toBe(200);
            gruppe = await KonfliktGruppe.findOne({ beteiligteAnfragen: anfrage_X._id });
            expect(gruppe).not.toBeNull();
            
            //Prüfe den Status aller Anfragen
            anfrage_X = await Anfrage.findById(anfrage_X._id);
            anfrage_Y = await Anfrage.findById(anfrage_Y._id);
            anfrage_Z = await Anfrage.findById(anfrage_Z._id);
            anfrage_V = await Anfrage.findById(anfrage_V._id);

            expect(gruppe.status).toBe('vollstaendig_geloest');
            
            expect(anfrage_X.Status).toBe('teilweise_bestaetigt_topf');
            expect(anfrage_X.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('abgelehnt_topf_marktanteil');
            expect(anfrage_X.ZugewieseneSlots[2].statusEinzelzuweisung).toBe('bestaetigt_topf');
            expect(anfrage_Y.Status).toBe('final_abgelehnt');
            expect(anfrage_Y.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('abgelehnt_topf_marktanteil');
            expect(anfrage_Z.Status).toBe('vollstaendig_bestaetigt_topf');
            expect(anfrage_Z.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('bestaetigt_topf_entgelt');
            expect(anfrage_V.Status).toBe('vollstaendig_bestaetigt_topf');
            expect(anfrage_V.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('bestaetigt_topf_entgelt');
        });

        it('sollte den max Marktanteil beim Entgeltvergleich korrekt berücksichtigen Fall 4', async () => {
            // ---- SETUP: Erzeuge einen Konflikt mit 2 Kapazitäten und 4 Anfragen, die bis zum Entgeltvergleich kommen ----

            
            const commonSlotParams2 = {
                von: "X", bis: "S", Abschnitt: "Nord-West",
                Verkehrsart: "SPFV", Abfahrt: { stunde: 8, minute: 0 }, Ankunft: { stunde: 8, minute: 45 },
                Grundentgelt: 120, Verkehrstag: "Mo-Fr"
            };

            for (let kw = 11; kw <= 13; kw++) {
                
                    // Erstelle 3 Slots pro Topf-Definition, um maxKap=2 zu erhalten
                    await request(app).post('/api/slots').send({ ...commonSlotParams2, Kalenderwoche: kw });
                    await request(app).post('/api/slots').send({ ...commonSlotParams2, Kalenderwoche: kw, Abfahrt: { stunde: 8, minute:  5 }, Ankunft: { stunde: 8, minute: 50 } });            
                    await request(app).post('/api/slots').send({ ...commonSlotParams2, Kalenderwoche: kw, Abfahrt: { stunde: 8, minute: 10 }, Ankunft: { stunde: 8, minute: 55 } });            
                
            }

            const s11 = await Slot.findOne({Abschnitt: 'Nord-West', Kalenderwoche: 11});
            const s12 = await Slot.findOne({Abschnitt: 'Nord-West', Kalenderwoche: 12});
            const s13 = await Slot.findOne({Abschnitt: 'Nord-West', Kalenderwoche: 13});

            // 1. Lade die drei Kapazitätstöpfe
            const kt_11 = await Kapazitaetstopf.findOne({bschnitt: 'Nord-West', Kalenderwoche: 11});
            const kt_12 = await Kapazitaetstopf.findOne({Kbschnitt: 'Nord-West', Kalenderwoche: 12});
            const kt_13 = await Kapazitaetstopf.findOne({Kbschnitt: 'Nord-West', Kalenderwoche: 13});
            
            // 2. Erstelle 4 Anfragen
            await new Anfrage({ Zugnummer: "X1", EVU: "Inv1", Verkehrsart: "SPFV", Verkehrstag: "Mo-Fr", Zeitraum: { start: "2025-03-10", ende: "2025-03-30" }, ListeGewuenschterSlotAbschnitte: [{von:"X", bis:"S", Abfahrtszeit:{stunde:8,minute:0}, Ankunftszeit:{stunde:8,minute:45}}], Email: 'rv@evu1.de',
            ZugewieseneSlots: [{slot: s11._id, statusEinzelzuweisung: 'wartet_konflikt_topf'}, {slot: s12._id, statusEinzelzuweisung: 'wartet_konflikt_topf'}, {slot: s13._id, statusEinzelzuweisung: 'wartet_konflikt_topf'}], Status: 'validiert' }).save();
            await new Anfrage({ Zugnummer: "Y1", EVU: "Inv1", Verkehrsart: "SPFV", Verkehrstag: "Mo-Fr", Zeitraum: { start: "2025-03-10", ende: "2025-03-23" }, ListeGewuenschterSlotAbschnitte: [{von:"X", bis:"S", Abfahrtszeit:{stunde:8,minute:0}, Ankunftszeit:{stunde:8,minute:45}}], Email: 'rv@evu2.de',
            ZugewieseneSlots: [{slot: s11._id, statusEinzelzuweisung: 'wartet_konflikt_topf'}, {slot: s12._id, statusEinzelzuweisung: 'wartet_konflikt_topf'}], Status: 'validiert'  }).save();
            await new Anfrage({ Zugnummer: "Z1", EVU: "Inv1", Verkehrsart: "SPFV", Verkehrstag: "Mo-Fr", Zeitraum: { start: "2025-03-10", ende: "2025-03-23" }, ListeGewuenschterSlotAbschnitte: [{von:"X", bis:"S", Abfahrtszeit:{stunde:8,minute:0}, Ankunftszeit:{stunde:8,minute:45}}], Email: 'rv@evu3.de',
            ZugewieseneSlots: [{slot: s11._id, statusEinzelzuweisung: 'wartet_konflikt_topf'}, {slot: s12._id, statusEinzelzuweisung: 'wartet_konflikt_topf'}], Status: 'validiert'  }).save();
            await new Anfrage({ Zugnummer: "V1", EVU: "Inv4", Verkehrsart: "SPFV", Verkehrstag: "Mo-Fr", Zeitraum: { start: "2025-03-11", ende: "2025-03-23" }, ListeGewuenschterSlotAbschnitte: [{von:"X", bis:"S", Abfahrtszeit:{stunde:8,minute:0}, Ankunftszeit:{stunde:8,minute:45}}], Email: 'rv@evu4.de',
            ZugewieseneSlots: [{slot: s11._id, statusEinzelzuweisung: 'wartet_konflikt_topf'}, {slot: s12._id, statusEinzelzuweisung: 'wartet_konflikt_topf'}], Status: 'validiert'  }).save();


            let anfrage_X = await Anfrage.findOne({Zugnummer: "X1"});
            let anfrage_Y = await Anfrage.findOne({Zugnummer: "Y1"});
            let anfrage_Z = await Anfrage.findOne({Zugnummer: "Z1"});
            let anfrage_V = await Anfrage.findOne({Zugnummer: "V1"});
            await request(app).post(`/api/anfragen/${anfrage_X._id}/zuordnen`).send();
            await request(app).post(`/api/anfragen/${anfrage_Y._id}/zuordnen`).send();
            await request(app).post(`/api/anfragen/${anfrage_Z._id}/zuordnen`).send();
            await request(app).post(`/api/anfragen/${anfrage_V._id}/zuordnen`).send();

            anfrage_X = await Anfrage.findById(anfrage_X._id);
            anfrage_X.Status = 'validiert'; anfrage_X.save();
            anfrage_Y = await Anfrage.findById(anfrage_Y._id);
            anfrage_Y.Status = 'validiert'; anfrage_Y.save();
            anfrage_Z = await Anfrage.findById(anfrage_Z._id);
            anfrage_Z.Status = 'validiert'; anfrage_Z.save();
            anfrage_V = await Anfrage.findById(anfrage_V._id);
            anfrage_V.Status = 'validiert'; anfrage_V.save();
            

            // 3. Erstelle ein Konfliktdokument pro KW und eine Gruppe, weil die maxKapa beider Töpfe gleich sind
            let response = await request(app)
                .post('/api/konflikte/identifiziere-topf-konflikte')
                .send();
            
            // ---- ÜBERPRÜFUNG ----
            expect(response.status).toBe(200);

            // Finde die resultierende Gruppe in der DB. Es darf nur eine geben.
            let anzahlGruppen = await KonfliktGruppe.countDocuments();
            expect(anzahlGruppen).toBe(1);
            let gruppe = await KonfliktGruppe.findOne({ beteiligteAnfragen: anfrage_X._id });
            expect(gruppe).not.toBeNull();
            expect(gruppe.status).toBe('offen');

            //Prüfe den Status aller Anfragen und deren Entgelt
            anfrage_X = await Anfrage.findById(anfrage_X._id);
            anfrage_Y = await Anfrage.findById(anfrage_Y._id);
            anfrage_Z = await Anfrage.findById(anfrage_Z._id);
            anfrage_V = await Anfrage.findById(anfrage_V._id);
            expect(anfrage_X.Status).toBe('in_konfliktloesung_topf');
            expect(anfrage_X.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('wartet_konflikt_topf');
            expect(anfrage_X.ZugewieseneSlots[2].statusEinzelzuweisung).toBe('bestaetigt_topf');
            expect(anfrage_Y.Status).toBe('in_konfliktloesung_topf');
            expect(anfrage_Y.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('wartet_konflikt_topf');
            expect(anfrage_Z.Status).toBe('in_konfliktloesung_topf');
            expect(anfrage_Z.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('wartet_konflikt_topf');
            expect(anfrage_V.Status).toBe('in_konfliktloesung_topf');
            expect(anfrage_V.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('wartet_konflikt_topf');
            expect(anfrage_X.Entgelt).toBe(15*120);
            expect(anfrage_Y.Entgelt).toBe(10*120);
            expect(anfrage_Z.Entgelt).toBe(10*120);
            expect(anfrage_V.Entgelt).toBe(9*120);


            // 4. Keine Anfrage vezichtet
            let loesenResponse = await request(app)
            .put(`/api/konflikte/gruppen/${gruppe._id}/verzicht-verschub`)
            .send({});

            // Überprüfung
            expect(loesenResponse.status).toBe(200);
            gruppe = await KonfliktGruppe.findOne({ beteiligteAnfragen: anfrage_X._id });
            expect(gruppe).not.toBeNull();
            expect(gruppe.status).toBe('in_bearbeitung_entgelt');

            //Prüfe den Status aller Anfragen
            anfrage_X = await Anfrage.findById(anfrage_X._id);
            anfrage_Y = await Anfrage.findById(anfrage_Y._id);
            anfrage_Z = await Anfrage.findById(anfrage_Z._id);
            anfrage_V = await Anfrage.findById(anfrage_V._id);
            expect(anfrage_X.Status).toBe('in_konfliktloesung_topf');
            expect(anfrage_X.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('wartet_entgeltentscheidung_topf');
            expect(anfrage_X.ZugewieseneSlots[2].statusEinzelzuweisung).toBe('bestaetigt_topf');
            expect(anfrage_Y.Status).toBe('in_konfliktloesung_topf');
            expect(anfrage_Y.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('wartet_entgeltentscheidung_topf');
            expect(anfrage_Z.Status).toBe('in_konfliktloesung_topf');
            expect(anfrage_Z.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('wartet_entgeltentscheidung_topf');
            expect(anfrage_V.Status).toBe('in_konfliktloesung_topf');
            expect(anfrage_V.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('wartet_entgeltentscheidung_topf');

            // 5. Entgeltvergleich anstoßen. Da pro EVU nur max 1 Zuweisung zulässig ist,
            // muss das EVU 1 seine 3 Anfragen  priorisieren. 
            // Weil Anfrage Z höher als Anfrage X und Y priorisiert wird, 
            // werden V und Z zugewiesen 
            // und Y und X aufgrund Marktanteil abgewiesen
            loesenResponse = await request(app)
                .put(`/api/konflikte/gruppen/${gruppe._id}/entgeltvergleich`)
                .send({
                    "evuReihungen": [
                                        {
                                            "evu": "Inv1",
                                            "anfrageIds": [
                                                anfrage_Z._id, // Anfrage mit höchster Priorität für Inv1
                                                anfrage_X._id, // Platz 2 für Inv1
                                                anfrage_Y._id, // Platz 3 für Inv1
                                            ]
                                        },
                                        {
                                            "evu": "Inv4",
                                            "anfrageIds": [
                                                anfrage_V._id, // Anfrage mit höchster Priorität für Inv4
                                            ]
                                        },
                                    ],
                });
            
            // Überprüfung
            expect(loesenResponse.status).toBe(200);
            gruppe = await KonfliktGruppe.findOne({ beteiligteAnfragen: anfrage_X._id });
            expect(gruppe).not.toBeNull();
            
            //Prüfe den Status aller Anfragen
            anfrage_X = await Anfrage.findById(anfrage_X._id);
            anfrage_Y = await Anfrage.findById(anfrage_Y._id);
            anfrage_Z = await Anfrage.findById(anfrage_Z._id);
            anfrage_V = await Anfrage.findById(anfrage_V._id);

            expect(gruppe.status).toBe('vollstaendig_geloest');
            
            expect(anfrage_X.Status).toBe('teilweise_bestaetigt_topf');
            expect(anfrage_X.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('abgelehnt_topf_marktanteil');
            expect(anfrage_X.ZugewieseneSlots[2].statusEinzelzuweisung).toBe('bestaetigt_topf');
            expect(anfrage_Y.Status).toBe('final_abgelehnt');
            expect(anfrage_Y.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('abgelehnt_topf_marktanteil');
            expect(anfrage_Z.Status).toBe('vollstaendig_bestaetigt_topf');
            expect(anfrage_Z.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('bestaetigt_topf_entgelt');
            expect(anfrage_V.Status).toBe('vollstaendig_bestaetigt_topf');
            expect(anfrage_V.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('bestaetigt_topf_entgelt');
        });
    });