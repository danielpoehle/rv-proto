// tests/integration/gruppenKonflikt.test.js
const request = require('supertest');
const mongoose = require('mongoose');
const app = require('../../server'); // Pfad zu deiner server.js
const {Slot} = require('../../models/Slot');
const Kapazitaetstopf = require('../../models/Kapazitaetstopf');
const Anfrage = require('../../models/Anfrage');
const KonfliktDokumentation = require('../../models/KonfliktDokumentation');
const KonfliktGruppe = require('../../models/KonfliktGruppe');
const { parseISO, addDays } = require('date-fns');

// Globale Konstante für den KW1-Start
const GLOBAL_KW1_START_DATE_ISO = "2024-12-30T00:00:00.000Z";

// Hilfsfunktion zum Formatieren der Zeit für die ID
function formatTimeForID(stunde, minute) {
    return `${String(stunde).padStart(2, '0')}${String(minute).padStart(2, '0')}`;
}


describe('Gruppierte Topf-Konfliktlösung', () => {
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
            slotTyp: "TAG",
            von: "Gruppenstadt-A", bis: "Gruppenstadt-B", Abschnitt: "Gruppen-Strecke1",
            Verkehrsart: "SPFV", Abfahrt: { stunde: 9, minute: 0 }, Ankunft: { stunde: 10, minute: 0 },
            Grundentgelt: grundentgelt
        };

        const commonSlotParams2 = {
            slotTyp: "TAG",
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
    it('sollte korrekt eine Konfliktgruppe mit 12 Topf-Konflikten und 4 beteiligten Anfragen identifizieren', async () => {
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
    it('sollte eine Gruppenentscheidung (Verzicht) korrekt auf alle 12 Topf-Konflikte anwenden und diese lösen', async () => {
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
    it('sollte eine Gruppenentscheidung (Entgeltvergleich eindeutig) korrekt auf alle 12 Topf-Konflikte anwenden und diese lösen', async () => {
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
    it('sollte eine Gruppenentscheidung (Entgeltvergleich Gleichstand) korrekt auf alle 12 Topf-Konflikte anwenden und diese als ungelöst markieren', async () => {
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
    it('sollte eine Gruppenentscheidung (Höchstpreisverfahren) korrekt auf alle 12 Topf-Konflikte anwenden und diese lösen', async () => {
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

describe('Konfliktgruppen-Status-Synchronisation (Topf-Konflikte)', () => {

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
                slotTyp: "TAG",
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
                slotTyp: "TAG",
                von: "S", bis: "T", Abschnitt: "Sued",
                Verkehrsart: "SPFV", Abfahrt: { stunde: 9, minute: 0 }, Ankunft: { stunde: 10, minute: 0 },
                Grundentgelt: 150, Verkehrstag: "Mo-Fr"
            };
            const commonSlotParams2 = {
                slotTyp: "TAG",
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

        it('sollte den Status der Gruppe und der Anfragen auch bei mehrmaliger Konfliktanalyse (Topf-Konflikte) korrekt beibehalten', async () => {
            // ---- SETUP: Erzeuge einen Konflikt mit 2 Kapazitäten und 4 Anfrage, die bis zum Höchstpreis kommen ----

            
            const commonSlotParams2 = {
                slotTyp: "TAG",
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
                slotTyp: "TAG",
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
                slotTyp: "TAG",
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
                slotTyp: "TAG",
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
                slotTyp: "TAG",
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

    describe('Gruppierte Slot-Konfliktlösung', () => {
        jest.setTimeout(60000);
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

            // 6 Slots für Abschn1 pro Woche erstellen, um maxKapazitaet = floor(0.7*6) = 4 zu erhalten
            const slotBasis = { slotTyp: "TAG", von: "Y", bis: "Z", Abschnitt: "Abschn1", 
                                    Verkehrstag: "Sa+So", Verkehrsart: "SPFV",
                                    Grundentgelt: 150 
                                };
                                
            let s1 = await request(app).post('/api/slots').send({ ...slotBasis, Kalenderwoche: 2, Abfahrt: { stunde: 13, minute: 10 }, Ankunft: { stunde: 14, minute: 0 } });
            await request(app).post('/api/slots').send({ ...slotBasis, Kalenderwoche: 2, Abfahrt: { stunde: 13, minute: 20 }, Ankunft: { stunde: 14, minute: 10 } });
            await request(app).post('/api/slots').send({ ...slotBasis, Kalenderwoche: 2, Abfahrt: { stunde: 13, minute: 30 }, Ankunft: { stunde: 14, minute: 20 } });
            await request(app).post('/api/slots').send({ ...slotBasis, Kalenderwoche: 2, Abfahrt: { stunde: 13, minute: 40 }, Ankunft: { stunde: 14, minute: 30 } });
            await request(app).post('/api/slots').send({ ...slotBasis, Kalenderwoche: 2, Abfahrt: { stunde: 13, minute: 50 }, Ankunft: { stunde: 14, minute: 40 } });
            await request(app).post('/api/slots').send({ ...slotBasis, Kalenderwoche: 2, Abfahrt: { stunde: 14, minute: 0 }, Ankunft: { stunde: 14, minute: 50 } });

            await request(app).post('/api/slots').send({ ...slotBasis, Kalenderwoche: 3, Abfahrt: { stunde: 13, minute: 10 }, Ankunft: { stunde: 14, minute: 0 } });
            await request(app).post('/api/slots').send({ ...slotBasis, Kalenderwoche: 3, Abfahrt: { stunde: 13, minute: 20 }, Ankunft: { stunde: 14, minute: 10 } });
            await request(app).post('/api/slots').send({ ...slotBasis, Kalenderwoche: 3, Abfahrt: { stunde: 13, minute: 30 }, Ankunft: { stunde: 14, minute: 20 } });
            await request(app).post('/api/slots').send({ ...slotBasis, Kalenderwoche: 3, Abfahrt: { stunde: 13, minute: 40 }, Ankunft: { stunde: 14, minute: 30 } });
            await request(app).post('/api/slots').send({ ...slotBasis, Kalenderwoche: 3, Abfahrt: { stunde: 13, minute: 50 }, Ankunft: { stunde: 14, minute: 40 } });
            await request(app).post('/api/slots').send({ ...slotBasis, Kalenderwoche: 3, Abfahrt: { stunde: 14, minute: 0 }, Ankunft: { stunde: 14, minute: 50 } });

            await request(app).post('/api/slots').send({ ...slotBasis, Kalenderwoche: 4, Abfahrt: { stunde: 13, minute: 10 }, Ankunft: { stunde: 14, minute: 0 } });
            await request(app).post('/api/slots').send({ ...slotBasis, Kalenderwoche: 4, Abfahrt: { stunde: 13, minute: 20 }, Ankunft: { stunde: 14, minute: 10 } });
            await request(app).post('/api/slots').send({ ...slotBasis, Kalenderwoche: 4, Abfahrt: { stunde: 13, minute: 30 }, Ankunft: { stunde: 14, minute: 20 } });
            await request(app).post('/api/slots').send({ ...slotBasis, Kalenderwoche: 4, Abfahrt: { stunde: 13, minute: 40 }, Ankunft: { stunde: 14, minute: 30 } });
            await request(app).post('/api/slots').send({ ...slotBasis, Kalenderwoche: 4, Abfahrt: { stunde: 13, minute: 50 }, Ankunft: { stunde: 14, minute: 40 } });
            await request(app).post('/api/slots').send({ ...slotBasis, Kalenderwoche: 4, Abfahrt: { stunde: 14, minute: 0 }, Ankunft: { stunde: 14, minute: 50 } });

            let kt_DetectConflict = await Kapazitaetstopf.findById(s1.body.data.VerweisAufTopf);
            expect(kt_DetectConflict.maxKapazitaet).toBe(4);

            const anfrageBasis = { Email: "conflict@evu.com", Verkehrsart: "SPFV", Verkehrstag: "Sa+So", Zeitraum: { start: "2025-01-06", ende: "2025-01-26" }, Status: 'validiert'}; // KW2-4 2025
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
            expect(response.body.toepfeOhneKonflikt).toHaveLength(3);

            //Zweiter Schritt: Slot-Konflikte
            response = await request(app)
                    .post('/api/konflikte/identifiziere-slot-konflikte')
                    .send();

            // Überprüfung der Antwort
            expect(response.status).toBe(200);
            expect(response.body.message).toBe('Konfliktdetektion für Slots abgeschlossen.');
            expect(response.body.neuErstellteKonflikte).toHaveLength(3);
            expect(response.body.aktualisierteUndGeoeffneteKonflikte).toHaveLength(0);
            expect(response.body.unveraenderteBestehendeKonflikte).toHaveLength(0);
            expect(response.body.autoGeloesteKonflikte).toHaveLength(0);
            expect(response.body.slotsOhneKonflikt).toHaveLength(15);

            const konfliktDokuId = response.body.neuErstellteKonflikte[1].id;

            // Überprüfung eines der erstellten Konfliktdokuments in der DB
            konfliktDokuDB = await KonfliktDokumentation.findById(konfliktDokuId);
            expect(konfliktDokuDB).not.toBeNull();
            expect(konfliktDokuDB.status).toBe('offen');
        });

        it('sollte korrekt eine Konfliktgruppe mit 3 Slot-Konflikten und 4 beteiligten Anfragen identifizieren', async () => {
            // Aktion
            const response = await request(app).get('/api/konflikte/gruppen').send();
            //console.log(response.body);

            // Überprüfung
            expect(response.status).toBe(200);
            expect(response.body.data).toHaveLength(1); // Es sollte genau eine Gruppe geben

            const gruppe = response.body.data[0];
            expect(gruppe.konflikteInGruppe).toHaveLength(3);
            expect(gruppe.beteiligteAnfragen).toHaveLength(4);

            const beteiligteIds = gruppe.beteiligteAnfragen.map(a => a._id.toString());
            expect(beteiligteIds).toContain(anfragenIds[0]._id.toString());
            expect(beteiligteIds).toContain(anfragenIds[1]._id.toString());
            expect(beteiligteIds).toContain(anfragenIds[2]._id.toString());
            expect(beteiligteIds).toContain(anfragenIds[3]._id.toString());
        });

        it('sollte korrekt Entscheidung Verzicht auf eine Konfliktgruppe mit 3 Slot-Konflikten und 4 beteiligten Anfragen durchführen', async () => {
            // Aktion
            let response = await request(app).get('/api/konflikte/gruppen').send();
            //console.log(response.body);

            // Überprüfung
            expect(response.status).toBe(200);
            let gruppe = response.body.data[0];
            expect(response.body.data).toHaveLength(1); // Es sollte genau eine Gruppe geben
            expect(gruppe.konflikteInGruppe).toHaveLength(3); // ... mit 3 Slot-Konflikten, je einer in KW 2-4
            expect(gruppe.beteiligteAnfragen).toHaveLength(4); // und allen 4 beteiligten Anfragen

            const gruppenId = response.body.data[0]._id;
            const testKonfliktDokuId = response.body.data[0].konflikteInGruppe[2];

            // Aktion: 3 Anfragen (anfrage1,2,4) verzichtet. Anfrage 3 gewinnt.
            const updatePayload = {
                ListeAnfragenMitVerzicht: [anfragenIds[0].toString(), anfragenIds[1].toString(), anfragenIds[3].toString()],
            };

            response = await request(app)
                .put(`/api/konflikte/slot-gruppen/${gruppenId}/verzicht-verschub`) // Neuer Endpunkt für Gruppen von Slot-Konflikten
                .send(updatePayload);

            expect(response.status).toBe(200);
            //console.log(response.body.data.gruppe);
            gruppe = response.body.data.gruppe;
            expect(gruppe.status).toBe('vollstaendig_geloest');
            
            // Wir schauen uns stichprobenartig die KW 3 an
            const aktualisierteKonfliktDoku = await KonfliktDokumentation.findById(testKonfliktDokuId);

            // Überprüfung des Konfliktdokuments
            expect(aktualisierteKonfliktDoku.status).toBe('geloest');
            expect(aktualisierteKonfliktDoku.ListeAnfragenMitVerzicht.map(id => id.toString()).sort()).toEqual([anfragenIds[0].toString(), anfragenIds[1].toString(), anfragenIds[3].toString()].sort());
            
            const zugewieseneIdsKonflikt = aktualisierteKonfliktDoku.zugewieseneAnfragen.map(id => id.toString());
            expect(zugewieseneIdsKonflikt).toHaveLength(1);
            expect(zugewieseneIdsKonflikt).toContain(anfragenIds[2].toString());
            expect(aktualisierteKonfliktDoku.abschlussdatum).toBeDefined();

            // Überprüfung der Anfragen-Status und Einzelzuweisungen
            const a1_updated = await Anfrage.findById(anfragenIds[0]).populate('ZugewieseneSlots.slot');
            const a2_updated = await Anfrage.findById(anfragenIds[1]).populate('ZugewieseneSlots.slot');
            const a3_updated = await Anfrage.findById(anfragenIds[2]).populate('ZugewieseneSlots.slot');
            const a4_updated = await Anfrage.findById(anfragenIds[3]).populate('ZugewieseneSlots.slot');
            //console.log(a1_updated);


            expect(a1_updated.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('abgelehnt_slot_verzichtet');          
            expect(a1_updated.Status).toBe('final_abgelehnt'); 

            expect(a2_updated.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('abgelehnt_slot_verzichtet');          
            expect(a2_updated.Status).toBe('final_abgelehnt'); 

            expect(a3_updated.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('bestaetigt_slot');          
            expect(a3_updated.Status).toBe('vollstaendig_final_bestaetigt'); 

            expect(a4_updated.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('abgelehnt_slot_verzichtet');          
            expect(a4_updated.Status).toBe('final_abgelehnt'); 
            
        });

        it('sollte korrekt den Entgeltvergleich auf eine Konfliktgruppe mit 3 Slot-Konflikten und 4 beteiligten Anfragen durchführen', async () => {
            // Aktion
            let response = await request(app).get('/api/konflikte/gruppen').send();
            //console.log(response.body);

            // Überprüfung
            expect(response.status).toBe(200);
            let gruppe = response.body.data[0];
            expect(response.body.data).toHaveLength(1); // Es sollte genau eine Gruppe geben
            expect(gruppe.konflikteInGruppe).toHaveLength(3); // ... mit 3 Slot-Konflikten, je einer in KW 2-4
            expect(gruppe.beteiligteAnfragen).toHaveLength(4); // und allen 4 beteiligten Anfragen

            const gruppenId = response.body.data[0]._id;
            const testKonfliktDokuId = response.body.data[0].konflikteInGruppe[2];

            // Aktion: Keine Anfrage verzichtet, eindeutige Entscheidung anhand des Entgelts löst den Konflikt.
            let a1 = await Anfrage.findById(anfragenIds[0]);
            let a2 = await Anfrage.findById(anfragenIds[1]);
            let a3 = await Anfrage.findById(anfragenIds[2]);
            let a4 = await Anfrage.findById(anfragenIds[3]); 
            
            a1.Entgelt = 700;  a1.save();
            a2.Entgelt = 900;  a2.save();
            a3.Entgelt = 800;  a3.save();
            a4.Entgelt = 1000; a4.save();

            // Keine Anfrage verzichtet     
            response = await request(app)
                .put(`/api/konflikte/slot-gruppen/${gruppenId}/verzicht-verschub`) // Neuer Endpunkt für Gruppen von Slot-Konflikten
                .send();

            expect(response.status).toBe(200);
            //console.log(response.body.data.gruppe);
            gruppe = response.body.data.gruppe;
            expect(gruppe.status).toBe('in_bearbeitung_entgelt');



            // Aktion: Entgeltvergleich für die Slots durchfüren
            response = await request(app)
                .put(`/api/konflikte/slot-gruppen/${gruppenId}/entgeltvergleich`) // Neuer Endpunkt für Gruppen von Slot-Konflikten
                .send();

            expect(response.status).toBe(200);
            //console.log(response.body.data.gruppe);
            gruppe = response.body.data.gruppe;
            expect(gruppe.status).toBe('vollstaendig_geloest');
            
            // Wir schauen uns stichprobenartig die KW 3 an
            const aktualisierteKonfliktDoku = await KonfliktDokumentation.findById(testKonfliktDokuId);

            // Überprüfung des Konfliktdokuments
            expect(aktualisierteKonfliktDoku.status).toBe('geloest');
            expect(aktualisierteKonfliktDoku.abschlussdatum).toBeDefined();            
                
            const zugewieseneIdsKonflikt = aktualisierteKonfliktDoku.zugewieseneAnfragen.map(id => id.toString());
            expect(zugewieseneIdsKonflikt).toHaveLength(1);
            expect(zugewieseneIdsKonflikt).toContain(a4._id.toString());

            const abgelehnteIdsKonflikt = aktualisierteKonfliktDoku.abgelehnteAnfragenEntgeltvergleich.map(id => id.toString());
            expect(abgelehnteIdsKonflikt).toHaveLength(3);
            expect(abgelehnteIdsKonflikt).toContain(a1._id.toString());
            expect(abgelehnteIdsKonflikt).toContain(a2._id.toString());
            expect(abgelehnteIdsKonflikt).toContain(a3._id.toString());

            // Überprüfung der Anfragen-Status und Einzelzuweisungen
            const a1_updated = await Anfrage.findById(anfragenIds[0]).populate('ZugewieseneSlots.slot');
            const a2_updated = await Anfrage.findById(anfragenIds[1]).populate('ZugewieseneSlots.slot');
            const a3_updated = await Anfrage.findById(anfragenIds[2]).populate('ZugewieseneSlots.slot');
            const a4_updated = await Anfrage.findById(anfragenIds[3]).populate('ZugewieseneSlots.slot');
            //console.log(a1_updated);


            expect(a1_updated.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('abgelehnt_slot_entgelt');          
            expect(a1_updated.Status).toBe('final_abgelehnt'); 

            expect(a2_updated.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('abgelehnt_slot_entgelt');          
            expect(a2_updated.Status).toBe('final_abgelehnt'); 

            expect(a3_updated.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('abgelehnt_slot_entgelt');          
            expect(a3_updated.Status).toBe('final_abgelehnt'); 

            expect(a4_updated.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('bestaetigt_slot_entgelt');          
            expect(a4_updated.Status).toBe('vollstaendig_final_bestaetigt'); 
            
        });

        it('sollte bei Gleichstand im Entgeltvergleich zum Hoechstpreis auf eine Konfliktgruppe mit 3 Slot-Konflikten und 4 beteiligten Anfragen wechseln', async () => {
            // Aktion
            let response = await request(app).get('/api/konflikte/gruppen').send();
            //console.log(response.body);

            // Überprüfung
            expect(response.status).toBe(200);
            let gruppe = response.body.data[0];
            expect(response.body.data).toHaveLength(1); // Es sollte genau eine Gruppe geben
            expect(gruppe.konflikteInGruppe).toHaveLength(3); // ... mit 3 Slot-Konflikten, je einer in KW 2-4
            expect(gruppe.beteiligteAnfragen).toHaveLength(4); // und allen 4 beteiligten Anfragen

            const gruppenId = response.body.data[0]._id;
            const testKonfliktDokuId = response.body.data[0].konflikteInGruppe[2];

            // Aktion: Keine Anfrage verzichtet, keine eindeutige Entscheidung anhand des Entgelts löst den Konflikt.
            let a1 = await Anfrage.findById(anfragenIds[0]);
            let a2 = await Anfrage.findById(anfragenIds[1]);
            let a3 = await Anfrage.findById(anfragenIds[2]);
            let a4 = await Anfrage.findById(anfragenIds[3]); 
            
            a1.Entgelt = 700;  a1.save();
            a2.Entgelt = 900;  a2.save();
            a3.Entgelt = 1000; a3.save();
            a4.Entgelt = 1000; a4.save();

            // Keine Anfrage verzichtet     
            response = await request(app)
                .put(`/api/konflikte/slot-gruppen/${gruppenId}/verzicht-verschub`) // Neuer Endpunkt für Gruppen von Slot-Konflikten
                .send();

            expect(response.status).toBe(200);
            //console.log(response.body.data.gruppe);
            gruppe = response.body.data.gruppe;
            expect(gruppe.status).toBe('in_bearbeitung_entgelt');



            // Aktion: Entgeltvergleich für die Slots durchfüren
            response = await request(app)
                .put(`/api/konflikte/slot-gruppen/${gruppenId}/entgeltvergleich`) // Neuer Endpunkt für Gruppen von Slot-Konflikten
                .send();

            expect(response.status).toBe(200);
            //console.log(response.body.data.gruppe);
            gruppe = response.body.data.gruppe;
            expect(gruppe.status).toBe('in_bearbeitung_hoechstpreis');
            
            // Wir schauen uns stichprobenartig die KW 3 an
            const aktualisierteKonfliktDoku = await KonfliktDokumentation.findById(testKonfliktDokuId);

            // Überprüfung des Konfliktdokuments
            expect(aktualisierteKonfliktDoku.status).toBe('in_bearbeitung_hoechstpreis');         
                
            const zugewieseneIdsKonflikt = aktualisierteKonfliktDoku.zugewieseneAnfragen.map(id => id.toString());
            expect(zugewieseneIdsKonflikt).toHaveLength(0);

            const abgelehnteIdsKonflikt = aktualisierteKonfliktDoku.abgelehnteAnfragenEntgeltvergleich.map(id => id.toString());
            expect(abgelehnteIdsKonflikt).toHaveLength(2);
            expect(abgelehnteIdsKonflikt).toContain(a1._id.toString());
            expect(abgelehnteIdsKonflikt).toContain(a2._id.toString());

            // Überprüfung der Anfragen-Status und Einzelzuweisungen
            const a1_updated = await Anfrage.findById(anfragenIds[0]).populate('ZugewieseneSlots.slot');
            const a2_updated = await Anfrage.findById(anfragenIds[1]).populate('ZugewieseneSlots.slot');
            const a3_updated = await Anfrage.findById(anfragenIds[2]).populate('ZugewieseneSlots.slot');
            const a4_updated = await Anfrage.findById(anfragenIds[3]).populate('ZugewieseneSlots.slot');
            //console.log(a1_updated);


            expect(a1_updated.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('abgelehnt_slot_entgelt');          
            expect(a1_updated.Status).toBe('final_abgelehnt'); 

            expect(a2_updated.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('abgelehnt_slot_entgelt');          
            expect(a2_updated.Status).toBe('final_abgelehnt'); 

            expect(a3_updated.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('wartet_hoechstpreis_slot');          
            expect(a3_updated.Status).toBe('in_konfliktloesung_slot'); 

            expect(a4_updated.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('wartet_hoechstpreis_slot');          
            expect(a4_updated.Status).toBe('in_konfliktloesung_slot'); 
            
        });

        it('sollte bei eindeutigen Geboten im Hoechstpreis auf eine Konfliktgruppe mit 3 Slot-Konflikten und 4 beteiligten Anfragen korrekt entscheiden', async () => {
            // Aktion
            let response = await request(app).get('/api/konflikte/gruppen').send();
            //console.log(response.body);

            // Überprüfung
            expect(response.status).toBe(200);
            let gruppe = response.body.data[0];
            expect(response.body.data).toHaveLength(1); // Es sollte genau eine Gruppe geben
            expect(gruppe.konflikteInGruppe).toHaveLength(3); // ... mit 3 Slot-Konflikten, je einer in KW 2-4
            expect(gruppe.beteiligteAnfragen).toHaveLength(4); // und allen 4 beteiligten Anfragen

            const gruppenId = response.body.data[0]._id;
            const testKonfliktDokuId = response.body.data[0].konflikteInGruppe[2];

            // Aktion: Keine Anfrage verzichtet, keine eindeutige Entscheidung anhand des Entgelts löst den Konflikt.
            let a1 = await Anfrage.findById(anfragenIds[0]);
            let a2 = await Anfrage.findById(anfragenIds[1]);
            let a3 = await Anfrage.findById(anfragenIds[2]);
            let a4 = await Anfrage.findById(anfragenIds[3]); 
            
            a1.Entgelt = 700;  a1.save();
            a2.Entgelt = 1000; a2.save();
            a3.Entgelt = 1000; a3.save();
            a4.Entgelt = 1000; a4.save();

            // Keine Anfrage verzichtet     
            response = await request(app)
                .put(`/api/konflikte/slot-gruppen/${gruppenId}/verzicht-verschub`) // Neuer Endpunkt für Gruppen von Slot-Konflikten
                .send();

            expect(response.status).toBe(200);
            //console.log(response.body.data.gruppe);
            gruppe = response.body.data.gruppe;
            expect(gruppe.status).toBe('in_bearbeitung_entgelt');



            // Aktion: Entgeltvergleich für die Slots durchfüren
            response = await request(app)
                .put(`/api/konflikte/slot-gruppen/${gruppenId}/entgeltvergleich`) // Neuer Endpunkt für Gruppen von Slot-Konflikten
                .send();

            expect(response.status).toBe(200);
            //console.log(response.body.data.gruppe);
            gruppe = response.body.data.gruppe;
            expect(gruppe.status).toBe('in_bearbeitung_hoechstpreis');

            // ---- AKTION: Ergebnisse des Höchstpreisverfahrens senden ----
            const hoechstpreisPayload = {
                ListeGeboteHoechstpreis: [
                    { anfrage: a2._id.toString(), gebot: (a2.Entgelt || 0) + 50 }, // Bietet 1050
                    { anfrage: a3._id.toString(), gebot: (a3.Entgelt || 0) + 20 }, // Bietet 1020
                    { anfrage: a4._id.toString(), gebot: (a4.Entgelt || 0) + 70 }  // Bietet 1070
                ]
            };

            response = await request(app)
                .put(`/api/konflikte/slot-gruppen/${gruppenId}/hoechstpreis-ergebnis`) // Neuer Endpunkt für Gruppen von Slot-Konflikten
                .send(hoechstpreisPayload);

            expect(response.status).toBe(200);
            //console.log(response.body.data.gruppe);
            gruppe = response.body.data;
            expect(gruppe.status).toBe('vollstaendig_geloest');
                
            // Wir schauen uns stichprobenartig die KW 3 an
            const aktualisierteKonfliktDoku = await KonfliktDokumentation.findById(testKonfliktDokuId);

            // Überprüfung des Konfliktdokuments
            expect(aktualisierteKonfliktDoku.status).toBe('geloest');
            expect(aktualisierteKonfliktDoku.abschlussdatum).toBeDefined();    
                
            const zugewieseneIdsKonflikt = aktualisierteKonfliktDoku.zugewieseneAnfragen.map(id => id.toString());
            expect(zugewieseneIdsKonflikt).toHaveLength(1);
            expect(zugewieseneIdsKonflikt).toContain(a4._id.toString());

            const abgelehnteIdsKonflikt = aktualisierteKonfliktDoku.abgelehnteAnfragenEntgeltvergleich.map(id => id.toString());
            expect(abgelehnteIdsKonflikt).toHaveLength(1);
            expect(abgelehnteIdsKonflikt).toContain(a1._id.toString());

            const abgelehnteIdsGebot = aktualisierteKonfliktDoku.abgelehnteAnfragenHoechstpreis.map(id => id.toString());
            expect(abgelehnteIdsGebot).toHaveLength(2);
            expect(abgelehnteIdsGebot).toContain(a2._id.toString());
            expect(abgelehnteIdsGebot).toContain(a3._id.toString());

            // Überprüfung der Anfragen-Status und Einzelzuweisungen
            const a1_updated = await Anfrage.findById(anfragenIds[0]).populate('ZugewieseneSlots.slot');
            const a2_updated = await Anfrage.findById(anfragenIds[1]).populate('ZugewieseneSlots.slot');
            const a3_updated = await Anfrage.findById(anfragenIds[2]).populate('ZugewieseneSlots.slot');
            const a4_updated = await Anfrage.findById(anfragenIds[3]).populate('ZugewieseneSlots.slot');
            //console.log(a1_updated);


            expect(a1_updated.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('abgelehnt_slot_entgelt');          
            expect(a1_updated.Status).toBe('final_abgelehnt'); 

            expect(a2_updated.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('abgelehnt_slot_hoechstpreis');          
            expect(a2_updated.Status).toBe('final_abgelehnt'); 

            expect(a3_updated.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('abgelehnt_slot_hoechstpreis');          
            expect(a3_updated.Status).toBe('final_abgelehnt'); 

            expect(a4_updated.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('bestaetigt_slot_hoechstpreis');          
            expect(a4_updated.Status).toBe('vollstaendig_final_bestaetigt'); 
            
        });
    });

    describe('Konfliktgruppen-Status-Synchronisation (Slot-Konflikte)', () => {

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

        it('sollte bei zwei Slots bei gleichen Anfragen zwei Gruppen von Slot-Konflikten bilden', async () => {
            // ---- SETUP: Erzeuge zwei Konflikte mit identischen Anfragen, aber unterschiedlichen Slots ----

            const commonSlotParams1 = {
                slotTyp: "TAG",
                von: "S", bis: "T", Abschnitt: "Sued",
                Verkehrsart: "SPFV", Abfahrt: { stunde: 9, minute: 0 }, Ankunft: { stunde: 10, minute: 0 },
                Grundentgelt: 150, Verkehrstag: "Mo-Fr"
            };
            const commonSlotParams2 = {
                slotTyp: "TAG",
                von: "X", bis: "S", Abschnitt: "West",
                Verkehrsart: "SPFV", Abfahrt: { stunde: 8, minute: 0 }, Ankunft: { stunde: 8, minute: 45 },
                Grundentgelt: 120, Verkehrstag: "Mo-Fr"
            };

            for (let kw = 11; kw <= 14; kw++) {
                
                    // Erstelle 3 Slots pro Topf-Definition, um maxKap=2 zu erhalten
                    await request(app).post('/api/slots').send({ ...commonSlotParams1, Kalenderwoche: kw });
                    await request(app).post('/api/slots').send({ ...commonSlotParams1, Kalenderwoche: kw, Abfahrt: { stunde: 9, minute: 10 }, Ankunft: { stunde: 10, minute: 10 } });  
                    await request(app).post('/api/slots').send({ ...commonSlotParams1, Kalenderwoche: kw, Abfahrt: { stunde: 9, minute: 20 }, Ankunft: { stunde: 10, minute: 20 } });  
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
            await new Anfrage({ Zugnummer: "X1", EVU: "Inv3", Verkehrsart: "SPFV", Verkehrstag: "Mo-Fr", Zeitraum: { start: "2025-03-10", ende: "2025-04-06" }, ListeGewuenschterSlotAbschnitte: [{von:"X", bis:"S", Abfahrtszeit:{stunde:8,minute:0}, Ankunftszeit:{stunde:8,minute:45}}, {von:"S", bis:"T", Abfahrtszeit:{stunde:9,minute:0}, Ankunftszeit:{stunde:10,minute:0}}], Email: 'rv@evu.de',
            ZugewieseneSlots: [{slot: s1._id, statusEinzelzuweisung: 'wartet_konflikt_topf'}, {slot: s2._id, statusEinzelzuweisung: 'wartet_konflikt_topf'}], Status: 'validiert' }).save();
            await new Anfrage({ Zugnummer: "Y1", EVU: "Inv4", Verkehrsart: "SPFV", Verkehrstag: "Mo-Fr", Zeitraum: { start: "2025-03-10", ende: "2025-04-06" }, ListeGewuenschterSlotAbschnitte: [{von:"X", bis:"S", Abfahrtszeit:{stunde:8,minute:0}, Ankunftszeit:{stunde:8,minute:45}}, {von:"S", bis:"T", Abfahrtszeit:{stunde:9,minute:0}, Ankunftszeit:{stunde:10,minute:0}}], Email: 'rv@evu.de',
            ZugewieseneSlots: [{slot: s1._id, statusEinzelzuweisung: 'wartet_konflikt_topf'}, {slot: s2._id, statusEinzelzuweisung: 'wartet_konflikt_topf'}], Status: 'validiert'  }).save();
            
            let anfrage_X = await Anfrage.findOne({Zugnummer: "X1"});
            let anfrage_Y = await Anfrage.findOne({Zugnummer: "Y1"});
            
            await request(app).post(`/api/anfragen/${anfrage_X._id}/zuordnen`).send();
            await request(app).post(`/api/anfragen/${anfrage_Y._id}/zuordnen`).send();
            

            anfrage_X = await Anfrage.findById(anfrage_X._id);
            anfrage_X.Status = 'validiert'; anfrage_X.save();
            anfrage_Y = await Anfrage.findById(anfrage_Y._id);
            anfrage_Y.Status = 'validiert'; anfrage_Y.save();
            
            

            // 3. Erstelle zwei Konfliktdokumente pro KW und zwei Gruppen, weil die maxKapa beider Töpfe unterschiedlich sind
            let response = await request(app)
                .post('/api/konflikte/identifiziere-topf-konflikte')
                .send();
            
            // ---- ÜBERPRÜFUNG ----
            expect(response.status).toBe(200);

            // Finde die resultierende Gruppe in der DB. Es darf nur eine geben.
            let anzahlGruppen = await KonfliktGruppe.countDocuments();
            expect(anzahlGruppen).toBe(0);

            //Zweiter Schritt: Slot-Konflikte
            response = await request(app)
                    .post('/api/konflikte/identifiziere-slot-konflikte')
                    .send();

            // Überprüfung der Antwort
            expect(response.status).toBe(200);
            anzahlGruppen = await KonfliktGruppe.countDocuments();
            expect(anzahlGruppen).toBe(2);

            let gruppen = await KonfliktGruppe.find({});
            expect(gruppen[0].beteiligteAnfragen.length).toBe(2);
            expect(gruppen[1].beteiligteAnfragen.length).toBe(2);
            expect(gruppen[0].konflikteInGruppe.length).toBe(4);
            expect(gruppen[1].konflikteInGruppe.length).toBe(4);
            const gruppenschluessel0 = `#${commonSlotParams1.von}#${commonSlotParams1.bis}#${formatTimeForID(commonSlotParams1.Abfahrt.stunde, commonSlotParams1.Abfahrt.minute)}#${commonSlotParams1.Verkehrsart}|${anfrage_X._id}#${anfrage_Y._id}`;
            const gruppenschluessel1 = `#${commonSlotParams2.von}#${commonSlotParams2.bis}#${formatTimeForID(commonSlotParams2.Abfahrt.stunde, commonSlotParams2.Abfahrt.minute)}#${commonSlotParams2.Verkehrsart}|${anfrage_X._id}#${anfrage_Y._id}`;
            expect(gruppen[0].gruppenSchluessel).toBe(gruppenschluessel0);
            expect(gruppen[1].gruppenSchluessel).toBe(gruppenschluessel1);
            //console.log(gruppen[0]);
        });

        it('sollte den Status der Gruppe und der Anfragen auch bei mehrmaliger Konfliktanalyse der Slot-Konflikte korrekt beibehalten', async () => {
            // ---- SETUP: Erzeuge einen Konflikt mit 4 Kapazitäten und 4 Anfragen auf dem selben Slot, die bis zum Höchstpreis kommen ----

            
            const commonSlotParams2 = {
                slotTyp: "TAG",
                von: "X", bis: "S", Abschnitt: "West",
                Verkehrsart: "SPFV", Abfahrt: { stunde: 8, minute: 0 }, Ankunft: { stunde: 8, minute: 45 },
                Grundentgelt: 120, Verkehrstag: "Mo-Fr"
            };

            for (let kw = 11; kw <= 13; kw++) {
                
                    // Erstelle 6 Slots pro Topf-Definition, um maxKap=4 zu erhalten
                    await request(app).post('/api/slots').send({ ...commonSlotParams2, Kalenderwoche: kw });
                    await request(app).post('/api/slots').send({ ...commonSlotParams2, Kalenderwoche: kw, Abfahrt: { stunde: 8, minute:  5 }, Ankunft: { stunde: 8, minute: 50 } });            
                    await request(app).post('/api/slots').send({ ...commonSlotParams2, Kalenderwoche: kw, Abfahrt: { stunde: 8, minute: 10 }, Ankunft: { stunde: 8, minute: 55 } });            
                    await request(app).post('/api/slots').send({ ...commonSlotParams2, Kalenderwoche: kw, Abfahrt: { stunde: 8, minute: 15 }, Ankunft: { stunde: 9, minute:  0 } });            
                    await request(app).post('/api/slots').send({ ...commonSlotParams2, Kalenderwoche: kw, Abfahrt: { stunde: 8, minute: 20 }, Ankunft: { stunde: 9, minute:  5 } });            
                    await request(app).post('/api/slots').send({ ...commonSlotParams2, Kalenderwoche: kw, Abfahrt: { stunde: 8, minute: 25 }, Ankunft: { stunde: 9, minute: 10 } });            
                
            }

            const s11 = await Slot.findOne({Abschnitt: 'West', Kalenderwoche: 11});
            const s12 = await Slot.findOne({Abschnitt: 'West', Kalenderwoche: 12});
            const s13 = await Slot.findOne({Abschnitt: 'West', Kalenderwoche: 13});

            // 1. Lade die drei Kapazitätstöpfe
            const kt_11 = await Kapazitaetstopf.findOne({Abschnitt: 'West', Kalenderwoche: 11});
            const kt_12 = await Kapazitaetstopf.findOne({Abschnitt: 'West', Kalenderwoche: 12});
            const kt_13 = await Kapazitaetstopf.findOne({Abschnitt: 'West', Kalenderwoche: 13});
            
            // 2. Erstelle 4 Anfragen
            await new Anfrage({ Zugnummer: "X1", EVU: "Inv1", Verkehrsart: "SPFV", Verkehrstag: "Mo-Fr", Zeitraum: { start: "2025-03-10", ende: "2025-03-30" }, ListeGewuenschterSlotAbschnitte: [{von:"X", bis:"S", Abfahrtszeit:{stunde:8,minute:0}, Ankunftszeit:{stunde:8,minute:45}}], Email: 'rv@evu1.de',
            ZugewieseneSlots: [{slot: s11._id, statusEinzelzuweisung: 'wartet_konflikt_topf'}, {slot: s12._id, statusEinzelzuweisung: 'wartet_konflikt_topf'}, {slot: s13._id, statusEinzelzuweisung: 'wartet_konflikt_topf'}], Status: 'validiert' }).save();
            await new Anfrage({ Zugnummer: "Y1", EVU: "Inv2", Verkehrsart: "SPFV", Verkehrstag: "Mo-Fr", Zeitraum: { start: "2025-03-10", ende: "2025-03-23" }, ListeGewuenschterSlotAbschnitte: [{von:"X", bis:"S", Abfahrtszeit:{stunde:8,minute:0}, Ankunftszeit:{stunde:8,minute:45}}], Email: 'rv@evu2.de',
            ZugewieseneSlots: [{slot: s11._id, statusEinzelzuweisung: 'wartet_konflikt_topf'}, {slot: s12._id, statusEinzelzuweisung: 'wartet_konflikt_topf'}], Status: 'validiert'  }).save();
            await new Anfrage({ Zugnummer: "Z1", EVU: "Inv3", Verkehrsart: "SPFV", Verkehrstag: "Mo-Fr", Zeitraum: { start: "2025-03-10", ende: "2025-03-23" }, ListeGewuenschterSlotAbschnitte: [{von:"X", bis:"S", Abfahrtszeit:{stunde:8,minute:0}, Ankunftszeit:{stunde:8,minute:45}}], Email: 'rv@evu3.de',
            ZugewieseneSlots: [{slot: s11._id, statusEinzelzuweisung: 'wartet_konflikt_topf'}, {slot: s12._id, statusEinzelzuweisung: 'wartet_konflikt_topf'}], Status: 'validiert'  }).save();
            await new Anfrage({ Zugnummer: "V1", EVU: "Inv4", Verkehrsart: "SPFV", Verkehrstag: "Mo-Fr", Zeitraum: { start: "2025-03-10", ende: "2025-03-23" }, ListeGewuenschterSlotAbschnitte: [{von:"X", bis:"S", Abfahrtszeit:{stunde:8,minute:0}, Ankunftszeit:{stunde:8,minute:45}}], Email: 'rv@evu4.de',
            ZugewieseneSlots: [{slot: s11._id, statusEinzelzuweisung: 'wartet_konflikt_topf'}, {slot: s12._id, statusEinzelzuweisung: 'wartet_konflikt_topf'}], Status: 'validiert'  }).save();


            let anfrage_X = await Anfrage.findOne({Zugnummer: "X1"}); //wird später tlw. abgelehnt wegen Entgelt
            let anfrage_Y = await Anfrage.findOne({Zugnummer: "Y1"}); //geht ins Höchstpreisverfahren
            let anfrage_Z = await Anfrage.findOne({Zugnummer: "Z1"}); //geht ins Höchstpreisverfahren
            let anfrage_V = await Anfrage.findOne({Zugnummer: "V1"}); //verzichtet
            await request(app).post(`/api/anfragen/${anfrage_X._id}/zuordnen`).send();
            await request(app).post(`/api/anfragen/${anfrage_Y._id}/zuordnen`).send();
            await request(app).post(`/api/anfragen/${anfrage_Z._id}/zuordnen`).send();
            await request(app).post(`/api/anfragen/${anfrage_V._id}/zuordnen`).send();

            anfrage_X = await Anfrage.findById(anfrage_X._id);
            anfrage_X.Status = 'validiert'; anfrage_X.Entgelt = 700;
            anfrage_X.save();
            anfrage_Y = await Anfrage.findById(anfrage_Y._id);
            anfrage_Y.Status = 'validiert'; anfrage_Y.Entgelt = 1000;
            anfrage_Y.save();
            anfrage_Z = await Anfrage.findById(anfrage_Z._id);
            anfrage_Z.Status = 'validiert'; anfrage_Z.Entgelt = 1000;
            anfrage_Z.save();
            anfrage_V = await Anfrage.findById(anfrage_V._id);
            anfrage_V.Status = 'validiert'; anfrage_V.Entgelt = 700;
            anfrage_V.save();
            

            // 3. Erstelle ein Konfliktdokument pro KW und eine Gruppe, weil die maxKapa beider Töpfe gleich sind
            let response = await request(app)
                .post('/api/konflikte/identifiziere-topf-konflikte')
                .send();
            
            // ---- ÜBERPRÜFUNG ----
            expect(response.status).toBe(200);

            // Finde die resultierende Gruppe in der DB. Es darf nur keine Topf-Konflikte geben.
            let anzahlGruppen = await KonfliktGruppe.countDocuments();
            expect(anzahlGruppen).toBe(0);

            //Zweiter Schritt: Slot-Konflikte
            response = await request(app)
                    .post('/api/konflikte/identifiziere-slot-konflikte')
                    .send();

            // Überprüfung der Antwort
            expect(response.status).toBe(200);
            anzahlGruppen = await KonfliktGruppe.countDocuments();
            expect(anzahlGruppen).toBe(1);

            let gruppe = await KonfliktGruppe.findOne({ beteiligteAnfragen: anfrage_X._id });
            expect(gruppe).not.toBeNull();
            expect(gruppe.status).toBe('offen');

            //Prüfe den Status aller Anfragen
            anfrage_X = await Anfrage.findById(anfrage_X._id);
            anfrage_Y = await Anfrage.findById(anfrage_Y._id);
            anfrage_Z = await Anfrage.findById(anfrage_Z._id);
            anfrage_V = await Anfrage.findById(anfrage_V._id);
            expect(anfrage_X.Status).toBe('in_konfliktloesung_slot');
            expect(anfrage_X.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('wartet_konflikt_slot');
            expect(anfrage_X.ZugewieseneSlots[2].statusEinzelzuweisung).toBe('bestaetigt_slot');
            expect(anfrage_Y.Status).toBe('in_konfliktloesung_slot');
            expect(anfrage_Y.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('wartet_konflikt_slot');
            expect(anfrage_Z.Status).toBe('in_konfliktloesung_slot');
            expect(anfrage_Z.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('wartet_konflikt_slot');
            expect(anfrage_V.Status).toBe('in_konfliktloesung_slot');
            expect(anfrage_V.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('wartet_konflikt_slot');

            // 4. Anfrage V vezichtet und danach wird die Konflikterkennung erneut angestoßen und darf nichts verändern
            let loesenResponse = await request(app)
            .put(`/api/konflikte/slot-gruppen/${gruppe._id}/verzicht-verschub`)
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
            expect(anfrage_X.Status).toBe('in_konfliktloesung_slot');
            expect(anfrage_X.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('wartet_entgeltentscheidung_slot');
            expect(anfrage_X.ZugewieseneSlots[2].statusEinzelzuweisung).toBe('bestaetigt_slot');
            expect(anfrage_Y.Status).toBe('in_konfliktloesung_slot');
            expect(anfrage_Y.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('wartet_entgeltentscheidung_slot');
            expect(anfrage_Z.Status).toBe('in_konfliktloesung_slot');
            expect(anfrage_Z.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('wartet_entgeltentscheidung_slot');
            expect(anfrage_V.Status).toBe('final_abgelehnt');
            expect(anfrage_V.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('abgelehnt_slot_verzichtet');

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
            expect(anfrage_X.Status).toBe('in_konfliktloesung_slot');
            expect(anfrage_X.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('wartet_entgeltentscheidung_slot');
            expect(anfrage_X.ZugewieseneSlots[2].statusEinzelzuweisung).toBe('bestaetigt_slot');
            expect(anfrage_Y.Status).toBe('in_konfliktloesung_slot');
            expect(anfrage_Y.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('wartet_entgeltentscheidung_slot');
            expect(anfrage_Z.Status).toBe('in_konfliktloesung_slot');
            expect(anfrage_Z.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('wartet_entgeltentscheidung_slot');
            expect(anfrage_V.Status).toBe('final_abgelehnt');
            expect(anfrage_V.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('abgelehnt_slot_verzichtet');

            response = await request(app)
                .post('/api/konflikte/identifiziere-slot-konflikte')
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
            expect(anfrage_X.Status).toBe('in_konfliktloesung_slot');
            expect(anfrage_X.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('wartet_entgeltentscheidung_slot');
            expect(anfrage_X.ZugewieseneSlots[2].statusEinzelzuweisung).toBe('bestaetigt_slot');
            expect(anfrage_Y.Status).toBe('in_konfliktloesung_slot');
            expect(anfrage_Y.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('wartet_entgeltentscheidung_slot');
            expect(anfrage_Z.Status).toBe('in_konfliktloesung_slot');
            expect(anfrage_Z.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('wartet_entgeltentscheidung_slot');
            expect(anfrage_V.Status).toBe('final_abgelehnt');
            expect(anfrage_V.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('abgelehnt_slot_verzichtet');

            // 5. Entgeltvergleich anstoßen, der Anfrage X ablehnt und die beiden verbleibenden 
            // Anfragen in das Höchstpreisverfahren gibt und danach wird die Konflikterkennung erneut angestoßen 
            // und darf nichts verändern     
            loesenResponse = await request(app)
                .put(`/api/konflikte/slot-gruppen/${gruppe._id}/entgeltvergleich`)
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
            expect(anfrage_X.Status).toBe('teilweise_final_bestaetigt');
            expect(anfrage_X.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('abgelehnt_slot_entgelt');
            expect(anfrage_X.ZugewieseneSlots[2].statusEinzelzuweisung).toBe('bestaetigt_slot');
            expect(anfrage_Y.Status).toBe('in_konfliktloesung_slot');
            expect(anfrage_Y.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('wartet_hoechstpreis_slot');
            expect(anfrage_Z.Status).toBe('in_konfliktloesung_slot');
            expect(anfrage_Z.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('wartet_hoechstpreis_slot');
            expect(anfrage_V.Status).toBe('final_abgelehnt');
            expect(anfrage_V.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('abgelehnt_slot_verzichtet');

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
            expect(anfrage_X.Status).toBe('teilweise_final_bestaetigt');
            expect(anfrage_X.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('abgelehnt_slot_entgelt');
            expect(anfrage_X.ZugewieseneSlots[2].statusEinzelzuweisung).toBe('bestaetigt_slot');
            expect(anfrage_Y.Status).toBe('in_konfliktloesung_slot');
            expect(anfrage_Y.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('wartet_hoechstpreis_slot');
            expect(anfrage_Z.Status).toBe('in_konfliktloesung_slot');
            expect(anfrage_Z.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('wartet_hoechstpreis_slot');
            expect(anfrage_V.Status).toBe('final_abgelehnt');
            expect(anfrage_V.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('abgelehnt_slot_verzichtet');

            response = await request(app)
                .post('/api/konflikte/identifiziere-slot-konflikte')
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
            expect(anfrage_X.Status).toBe('teilweise_final_bestaetigt');
            expect(anfrage_X.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('abgelehnt_slot_entgelt');
            expect(anfrage_X.ZugewieseneSlots[2].statusEinzelzuweisung).toBe('bestaetigt_slot');
            expect(anfrage_Y.Status).toBe('in_konfliktloesung_slot');
            expect(anfrage_Y.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('wartet_hoechstpreis_slot');
            expect(anfrage_Z.Status).toBe('in_konfliktloesung_slot');
            expect(anfrage_Z.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('wartet_hoechstpreis_slot');
            expect(anfrage_V.Status).toBe('final_abgelehnt');
            expect(anfrage_V.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('abgelehnt_slot_verzichtet');

            // 6. Ergebnisse des Höchstpreisverfahrens senden und erneut Konfliktanalyse starten
            const hoechstpreisPayload = {
                ListeGeboteHoechstpreis: [
                    { anfrage: anfrage_Y._id.toString(), gebot: 2500 }, // Y bietet 2500, Z gibt kein Gebot ab
                ]
            };

            loesenResponse = await request(app)
                .put(`/api/konflikte/slot-gruppen/${gruppe._id}/hoechstpreis-ergebnis`)
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
            expect(anfrage_X.Status).toBe('teilweise_final_bestaetigt');
            expect(anfrage_X.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('abgelehnt_slot_entgelt');
            expect(anfrage_X.ZugewieseneSlots[2].statusEinzelzuweisung).toBe('bestaetigt_slot');
            expect(anfrage_Y.Status).toBe('vollstaendig_final_bestaetigt');
            expect(anfrage_Y.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('bestaetigt_slot_hoechstpreis');
            expect(anfrage_Z.Status).toBe('final_abgelehnt');
            expect(anfrage_Z.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('abgelehnt_slot_hoechstpreis_kein_gebot');
            expect(anfrage_V.Status).toBe('final_abgelehnt');
            expect(anfrage_V.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('abgelehnt_slot_verzichtet');

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
            expect(anfrage_X.Status).toBe('teilweise_final_bestaetigt');
            expect(anfrage_X.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('abgelehnt_slot_entgelt');
            expect(anfrage_X.ZugewieseneSlots[2].statusEinzelzuweisung).toBe('bestaetigt_slot');
            expect(anfrage_Y.Status).toBe('vollstaendig_final_bestaetigt');
            expect(anfrage_Y.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('bestaetigt_slot_hoechstpreis');
            expect(anfrage_Z.Status).toBe('final_abgelehnt');
            expect(anfrage_Z.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('abgelehnt_slot_hoechstpreis_kein_gebot');
            expect(anfrage_V.Status).toBe('final_abgelehnt');
            expect(anfrage_V.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('abgelehnt_slot_verzichtet');

            response = await request(app)
                .post('/api/konflikte/identifiziere-slot-konflikte')
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
            expect(anfrage_X.Status).toBe('teilweise_final_bestaetigt');
            expect(anfrage_X.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('abgelehnt_slot_entgelt');
            expect(anfrage_X.ZugewieseneSlots[2].statusEinzelzuweisung).toBe('bestaetigt_slot');
            expect(anfrage_Y.Status).toBe('vollstaendig_final_bestaetigt');
            expect(anfrage_Y.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('bestaetigt_slot_hoechstpreis');
            expect(anfrage_Z.Status).toBe('final_abgelehnt');
            expect(anfrage_Z.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('abgelehnt_slot_hoechstpreis_kein_gebot');
            expect(anfrage_V.Status).toBe('final_abgelehnt');
            expect(anfrage_V.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('abgelehnt_slot_verzichtet');
        });
    });

describe('Konfliktgruppen-Status-Synchronisation Topf-Konflikte - Konflikt in der Nacht komplett durchspielen', () => {
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


            const slotData3 = {
            slotTyp: "NACHT", von: "C", bis: "D", Abschnitt: "Strecke3", 
            Verkehrstag: "täglich", 
            zeitraumStart: '2025-07-07',  
            zeitraumEnde: '2025-08-03',  
            Grundentgelt: 100,
            Zeitfenster: '03-05',
            Mindestfahrzeit: 60,
            Maximalfahrzeit: 90
            };

            const slotData4 = {
            slotTyp: "TAG", von: "D", bis: "E", Abschnitt: "Strecke4",             
            Verkehrstag: "täglich",       
            zeitraumStart: '2025-07-07',  
            zeitraumEnde: '2025-08-03',  
            Verkehrsart: "SGV",  
            Grundentgelt: 100
            };

            const slotData5 = {
            slotTyp: "TAG", von: "D", bis: "F", Abschnitt: "Strecke5",             
            Verkehrstag: "täglich",       
            zeitraumStart: '2025-07-07',  
            zeitraumEnde: '2025-08-03',  
            Verkehrsart: "SGV",  
            Grundentgelt: 100
            };

            //3 Nacht-Slots auf C-D --> Kapazität von 2
            response = await request(app)
                .post('/api/slots/massen-erstellung')
                .send(slotData3);
            expect(response.status).toBe(201);
            expect(response.body.erstellteSlots).toBeDefined();
            response = await request(app)
                .post('/api/slots/massen-erstellung')
                .send(slotData3);
            expect(response.status).toBe(201);
            expect(response.body.erstellteSlots).toBeDefined();
            response = await request(app)
                .post('/api/slots/massen-erstellung')
                .send(slotData3);
            expect(response.status).toBe(201);
            expect(response.body.erstellteSlots).toBeDefined();
            
            // 5 Tages-Slots auf D-E --> Kapazität von 3
            response = await request(app)
                .post('/api/slots/massen-erstellung')
                .send({...slotData4, Abfahrt: { stunde: 5, minute: 3 }, Ankunft: { stunde: 6, minute: 49 },});
            expect(response.status).toBe(201);
            expect(response.body.erstellteSlots).toBeDefined();
            response = await request(app)
                .post('/api/slots/massen-erstellung')
                .send({...slotData4, Abfahrt: { stunde: 5, minute: 13 }, Ankunft: { stunde: 6, minute: 59 },});
            expect(response.status).toBe(201);
            expect(response.body.erstellteSlots).toBeDefined();
            response = await request(app)
                .post('/api/slots/massen-erstellung')
                .send({...slotData4, Abfahrt: { stunde: 5, minute: 23 }, Ankunft: { stunde: 7, minute: 9 },});
            expect(response.status).toBe(201);
            expect(response.body.erstellteSlots).toBeDefined();
            response = await request(app)
                .post('/api/slots/massen-erstellung')
                .send({...slotData4, Abfahrt: { stunde: 5, minute: 33 }, Ankunft: { stunde: 7, minute: 19 },});
            expect(response.status).toBe(201);
            expect(response.body.erstellteSlots).toBeDefined();
            response = await request(app)
                .post('/api/slots/massen-erstellung')
                .send({...slotData4, Abfahrt: { stunde: 5, minute: 43 }, Ankunft: { stunde: 7, minute: 29 },});
            expect(response.status).toBe(201);
            expect(response.body.erstellteSlots).toBeDefined();

            // 5 Tages-Slots auf D-F --< Kapazität von 3
            response = await request(app)
                .post('/api/slots/massen-erstellung')
                .send({...slotData5, Abfahrt: { stunde: 5, minute: 7 }, Ankunft: { stunde: 6, minute: 49 },});
            expect(response.status).toBe(201);
            expect(response.body.erstellteSlots).toBeDefined();
            response = await request(app)
                .post('/api/slots/massen-erstellung')
                .send({...slotData5, Abfahrt: { stunde: 5, minute: 17 }, Ankunft: { stunde: 6, minute: 59 },});
            expect(response.status).toBe(201);
            expect(response.body.erstellteSlots).toBeDefined();
            response = await request(app)
                .post('/api/slots/massen-erstellung')
                .send({...slotData5, Abfahrt: { stunde: 5, minute: 27 }, Ankunft: { stunde: 7, minute: 9 },});
            expect(response.status).toBe(201);
            expect(response.body.erstellteSlots).toBeDefined();
            response = await request(app)
                .post('/api/slots/massen-erstellung')
                .send({...slotData5, Abfahrt: { stunde: 5, minute: 37 }, Ankunft: { stunde: 7, minute: 19 },});
            expect(response.status).toBe(201);
            expect(response.body.erstellteSlots).toBeDefined();
            response = await request(app)
                .post('/api/slots/massen-erstellung')
                .send({...slotData5, Abfahrt: { stunde: 5, minute: 47 }, Ankunft: { stunde: 7, minute: 29 },});
            expect(response.status).toBe(201);
            expect(response.body.erstellteSlots).toBeDefined();

            kt_all = await Kapazitaetstopf.find({});
            expect(kt_all.length).toBe(24);
        });

        it('sollte den Status der Gruppe und der Anfragen auch bei mehrmaliger Konfliktanalyse bei Topf-Konflikt in der Nacht korrekt beibehalten', async () => {
            // 6 Anfragen auf Nacht-Kapazitätstopf mit Kapa 2
            // 1 Anfrage verzichtet
            // 1 Anfrage wird aufgrund Entgelt zugewiesen, 1 Anfrage aufgrund Entgelt abgelehnt
            // 3 Anfragen gehen ins Höchstpreisverfahren, 1x kein Gebot, 2 Gebote mit eindeutiger Entscheidung
            const anfrageBasis = { Email: "conflict@evu.com", Verkehrsart: "SGV", Verkehrstag: "Mo-Fr", Zeitraum: { start: "2025-07-14", ende: "2025-07-20" }, Status: 'validiert'}; // KW29 2025
            
            let anfrage_V = await new Anfrage({ ...anfrageBasis, EVU: "ConflictEVU1" , Zugnummer: "C1", 
                                            ListeGewuenschterSlotAbschnitte: [ 
                                                {von: "C", bis:"D", Abfahrtszeit: {stunde:3, minute:45 }, Ankunftszeit:{stunde:4,minute:53}},
                                                {von: "D", bis:"E", Abfahrtszeit: {stunde:5, minute:3 }, Ankunftszeit:{stunde:6,minute:49}}
                                            ]
                                        }).save();
                                    
            let anfrage_E1 = await new Anfrage({ ...anfrageBasis, EVU: "ConflictEVU2" , Zugnummer: "C2", 
                                            ListeGewuenschterSlotAbschnitte: [ 
                                                {von: "C", bis:"D", Abfahrtszeit: {stunde:3, minute:50 }, Ankunftszeit:{stunde:4,minute:59}},
                                                {von: "D", bis:"E", Abfahrtszeit: {stunde:5, minute:13 }, Ankunftszeit:{stunde:6,minute:59}}
                                            ]
                                        }).save();

            let anfrage_E2 = await new Anfrage({ ...anfrageBasis, EVU: "ConflictEVU3" , Zugnummer: "C3", 
                                            ListeGewuenschterSlotAbschnitte: [ 
                                                {von: "C", bis:"D", Abfahrtszeit: {stunde:3, minute:55 }, Ankunftszeit:{stunde:5,minute:9}},
                                                {von: "D", bis:"E", Abfahrtszeit: {stunde:5, minute:23 }, Ankunftszeit:{stunde:7,minute:9}}
                                            ]
                                        }).save();

            let anfrage_H1 = await new Anfrage({ ...anfrageBasis, EVU: "ConflictEVU4" , Zugnummer: "C4", 
                                            ListeGewuenschterSlotAbschnitte: [ 
                                                {von: "C", bis:"D", Abfahrtszeit: {stunde:4, minute:8 }, Ankunftszeit:{stunde:5,minute:9}},
                                                {von: "D", bis:"F", Abfahrtszeit: {stunde:5, minute:17 }, Ankunftszeit:{stunde:6,minute:59}}
                                            ]
                                        }).save();

            let anfrage_H2 = await new Anfrage({ ...anfrageBasis, EVU: "ConflictEVU5" , Zugnummer: "C5", 
                                            ListeGewuenschterSlotAbschnitte: [ 
                                                {von: "C", bis:"D", Abfahrtszeit: {stunde:4, minute:15 }, Ankunftszeit:{stunde:5,minute:21}},
                                                {von: "D", bis:"F", Abfahrtszeit: {stunde:5, minute:27 }, Ankunftszeit:{stunde:7,minute:9}}
                                            ]
                                        }).save();

            let anfrage_H3 = await new Anfrage({ ...anfrageBasis, EVU: "ConflictEVU6" , Zugnummer: "C6", 
                                            ListeGewuenschterSlotAbschnitte: [ 
                                                {von: "C", bis:"D", Abfahrtszeit: {stunde:4, minute:22 }, Ankunftszeit:{stunde:5,minute:24}},
                                                {von: "D", bis:"F", Abfahrtszeit: {stunde:5, minute:37 }, Ankunftszeit:{stunde:7,minute:19}}
                                            ]
                                        }).save();

            anfrage_V = await Anfrage.findOne({Zugnummer: "C1"});
            anfrage_E1 = await Anfrage.findOne({Zugnummer: "C2"});
            anfrage_E2 = await Anfrage.findOne({Zugnummer: "C3"});
            anfrage_H1 = await Anfrage.findOne({Zugnummer: "C4"});
            anfrage_H2 = await Anfrage.findOne({Zugnummer: "C5"});
            anfrage_H3 = await Anfrage.findOne({Zugnummer: "C6"});
            

            await request(app).post(`/api/anfragen/${anfrage_V._id}/zuordnen`).send();
            await request(app).post(`/api/anfragen/${anfrage_E1._id}/zuordnen`).send();
            await request(app).post(`/api/anfragen/${anfrage_E2._id}/zuordnen`).send();
            await request(app).post(`/api/anfragen/${anfrage_H1._id}/zuordnen`).send();
            await request(app).post(`/api/anfragen/${anfrage_H2._id}/zuordnen`).send();
            await request(app).post(`/api/anfragen/${anfrage_H3._id}/zuordnen`).send();

            anfrage_V = await Anfrage.findOne({Zugnummer: "C1"});
            anfrage_V.Status = 'validiert'; anfrage_V.save();
            anfrage_E1 = await Anfrage.findOne({Zugnummer: "C2"});
            anfrage_E1.Status = 'validiert'; anfrage_E1.Entgelt = 100; anfrage_E1.save();
            anfrage_E2 = await Anfrage.findOne({Zugnummer: "C3"});
            anfrage_E2.Status = 'validiert'; anfrage_E2.Entgelt = 1500; anfrage_E2.save();
            anfrage_H1 = await Anfrage.findOne({Zugnummer: "C4"});
            anfrage_H1.Status = 'validiert'; anfrage_H1.save();
            anfrage_H2 = await Anfrage.findOne({Zugnummer: "C5"});
            anfrage_H2.Status = 'validiert'; anfrage_H2.save();
            anfrage_H3 = await Anfrage.findOne({Zugnummer: "C6"});
            anfrage_H3.Status = 'validiert'; anfrage_H3.save();

            // 3. Erstelle ein Konfliktdokument für die Nacht
            let response = await request(app)
                .post('/api/konflikte/identifiziere-topf-konflikte')
                .send();
            
            // ---- ÜBERPRÜFUNG ----
            expect(response.status).toBe(200);

            // Finde die resultierende Gruppe in der DB. Es darf nur eine geben.
            let anzahlGruppen = await KonfliktGruppe.countDocuments();
            expect(anzahlGruppen).toBe(1);
            let gruppe = await KonfliktGruppe.findOne({ beteiligteAnfragen: anfrage_V._id });
            expect(gruppe).not.toBeNull();
            expect(gruppe.status).toBe('offen');

            //Prüfe den Status aller Anfragen
            anfrage_V = await Anfrage.findOne({Zugnummer: "C1"});
            anfrage_E1 = await Anfrage.findOne({Zugnummer: "C2"});
            anfrage_E2 = await Anfrage.findOne({Zugnummer: "C3"});
            anfrage_H1 = await Anfrage.findOne({Zugnummer: "C4"});
            anfrage_H2 = await Anfrage.findOne({Zugnummer: "C5"});
            anfrage_H3 = await Anfrage.findOne({Zugnummer: "C6"});

            expect(anfrage_V.Status).toBe('in_konfliktloesung_topf');
            expect(anfrage_V.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('wartet_konflikt_topf');
            expect(anfrage_V.ZugewieseneSlots[1].statusEinzelzuweisung).toBe('bestaetigt_topf');

            expect(anfrage_E1.Status).toBe('in_konfliktloesung_topf');
            expect(anfrage_E1.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('wartet_konflikt_topf');
            expect(anfrage_E1.ZugewieseneSlots[1].statusEinzelzuweisung).toBe('bestaetigt_topf');

            expect(anfrage_E2.Status).toBe('in_konfliktloesung_topf');
            expect(anfrage_E2.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('wartet_konflikt_topf');
            expect(anfrage_E2.ZugewieseneSlots[1].statusEinzelzuweisung).toBe('bestaetigt_topf');

            expect(anfrage_H1.Status).toBe('in_konfliktloesung_topf');
            expect(anfrage_H1.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('wartet_konflikt_topf');
            expect(anfrage_H1.ZugewieseneSlots[1].statusEinzelzuweisung).toBe('bestaetigt_topf');

            expect(anfrage_H2.Status).toBe('in_konfliktloesung_topf');
            expect(anfrage_H2.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('wartet_konflikt_topf');
            expect(anfrage_H2.ZugewieseneSlots[1].statusEinzelzuweisung).toBe('bestaetigt_topf');

            expect(anfrage_H3.Status).toBe('in_konfliktloesung_topf');
            expect(anfrage_H3.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('wartet_konflikt_topf');
            expect(anfrage_H3.ZugewieseneSlots[1].statusEinzelzuweisung).toBe('bestaetigt_topf');

            // 4. Anfrage V vezichtet und danach wird die Konflikterkennung erneut angestoßen und darf nichts verändern
            let loesenResponse = await request(app)
            .put(`/api/konflikte/gruppen/${gruppe._id}/verzicht-verschub`)
            .send({ListeAnfragenMitVerzicht: [anfrage_V._id.toString()]});

            // Überprüfung
            expect(loesenResponse.status).toBe(200);
            gruppe = await KonfliktGruppe.findOne({ beteiligteAnfragen: anfrage_V._id });
            expect(gruppe).not.toBeNull();
            expect(gruppe.status).toBe('in_bearbeitung_entgelt');

            //Prüfe den Status aller Anfragen
            anfrage_V = await Anfrage.findOne({Zugnummer: "C1"});
            anfrage_E1 = await Anfrage.findOne({Zugnummer: "C2"});
            anfrage_E2 = await Anfrage.findOne({Zugnummer: "C3"});
            anfrage_H1 = await Anfrage.findOne({Zugnummer: "C4"});
            anfrage_H2 = await Anfrage.findOne({Zugnummer: "C5"});
            anfrage_H3 = await Anfrage.findOne({Zugnummer: "C6"});

            expect(anfrage_V.Status).toBe('teilweise_bestaetigt_topf');
            expect(anfrage_V.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('abgelehnt_topf_verzichtet');
            expect(anfrage_V.ZugewieseneSlots[1].statusEinzelzuweisung).toBe('bestaetigt_topf');

            expect(anfrage_E1.Status).toBe('in_konfliktloesung_topf');
            expect(anfrage_E1.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('wartet_entgeltentscheidung_topf');
            expect(anfrage_E1.ZugewieseneSlots[1].statusEinzelzuweisung).toBe('bestaetigt_topf');

            expect(anfrage_E2.Status).toBe('in_konfliktloesung_topf');
            expect(anfrage_E2.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('wartet_entgeltentscheidung_topf');
            expect(anfrage_E2.ZugewieseneSlots[1].statusEinzelzuweisung).toBe('bestaetigt_topf');

            expect(anfrage_H1.Status).toBe('in_konfliktloesung_topf');
            expect(anfrage_H1.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('wartet_entgeltentscheidung_topf');
            expect(anfrage_H1.ZugewieseneSlots[1].statusEinzelzuweisung).toBe('bestaetigt_topf');

            expect(anfrage_H2.Status).toBe('in_konfliktloesung_topf');
            expect(anfrage_H2.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('wartet_entgeltentscheidung_topf');
            expect(anfrage_H2.ZugewieseneSlots[1].statusEinzelzuweisung).toBe('bestaetigt_topf');

            expect(anfrage_H3.Status).toBe('in_konfliktloesung_topf');
            expect(anfrage_H3.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('wartet_entgeltentscheidung_topf');
            expect(anfrage_H3.ZugewieseneSlots[1].statusEinzelzuweisung).toBe('bestaetigt_topf');

            response = await request(app)
                .post('/api/konflikte/identifiziere-topf-konflikte')
                .send();
            
            // Überprüfung
            expect(response.status).toBe(200);
            gruppe = await KonfliktGruppe.findOne({ beteiligteAnfragen: anfrage_V._id });
            expect(gruppe).not.toBeNull();
            expect(gruppe.status).toBe('in_bearbeitung_entgelt');

            //Prüfe den Status aller Anfragen
            anfrage_V = await Anfrage.findOne({Zugnummer: "C1"});
            anfrage_E1 = await Anfrage.findOne({Zugnummer: "C2"});
            anfrage_E2 = await Anfrage.findOne({Zugnummer: "C3"});
            anfrage_H1 = await Anfrage.findOne({Zugnummer: "C4"});
            anfrage_H2 = await Anfrage.findOne({Zugnummer: "C5"});
            anfrage_H3 = await Anfrage.findOne({Zugnummer: "C6"});

            expect(anfrage_V.Status).toBe('teilweise_bestaetigt_topf');
            expect(anfrage_V.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('abgelehnt_topf_verzichtet');
            expect(anfrage_V.ZugewieseneSlots[1].statusEinzelzuweisung).toBe('bestaetigt_topf');

            expect(anfrage_E1.Status).toBe('in_konfliktloesung_topf');
            expect(anfrage_E1.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('wartet_entgeltentscheidung_topf');
            expect(anfrage_E1.ZugewieseneSlots[1].statusEinzelzuweisung).toBe('bestaetigt_topf');

            expect(anfrage_E2.Status).toBe('in_konfliktloesung_topf');
            expect(anfrage_E2.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('wartet_entgeltentscheidung_topf');
            expect(anfrage_E2.ZugewieseneSlots[1].statusEinzelzuweisung).toBe('bestaetigt_topf');

            expect(anfrage_H1.Status).toBe('in_konfliktloesung_topf');
            expect(anfrage_H1.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('wartet_entgeltentscheidung_topf');
            expect(anfrage_H1.ZugewieseneSlots[1].statusEinzelzuweisung).toBe('bestaetigt_topf');

            expect(anfrage_H2.Status).toBe('in_konfliktloesung_topf');
            expect(anfrage_H2.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('wartet_entgeltentscheidung_topf');
            expect(anfrage_H2.ZugewieseneSlots[1].statusEinzelzuweisung).toBe('bestaetigt_topf');

            expect(anfrage_H3.Status).toBe('in_konfliktloesung_topf');
            expect(anfrage_H3.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('wartet_entgeltentscheidung_topf');
            expect(anfrage_H3.ZugewieseneSlots[1].statusEinzelzuweisung).toBe('bestaetigt_topf');

            // 5. Entgeltvergleich anstoßen, der Anfrage E2 erforgreich zuweist, E1 ablehnt und die drei verbleibenden 
            // Anfragen in das Höchstpreisverfahren gibt und danach wird die Konflikterkennung erneut angestoßen 
            // und darf nichts verändern   
            loesenResponse = await request(app)
                .put(`/api/konflikte/gruppen/${gruppe._id}/entgeltvergleich`)
                .send({});

            // Überprüfung
            expect(loesenResponse.status).toBe(200);
            gruppe = await KonfliktGruppe.findOne({ beteiligteAnfragen: anfrage_V._id });
            expect(gruppe).not.toBeNull();
            expect(gruppe.status).toBe('in_bearbeitung_hoechstpreis');

            //Prüfe den Status aller Anfragen
            anfrage_V = await Anfrage.findOne({Zugnummer: "C1"});
            anfrage_E1 = await Anfrage.findOne({Zugnummer: "C2"});
            anfrage_E2 = await Anfrage.findOne({Zugnummer: "C3"});
            anfrage_H1 = await Anfrage.findOne({Zugnummer: "C4"});
            anfrage_H2 = await Anfrage.findOne({Zugnummer: "C5"});
            anfrage_H3 = await Anfrage.findOne({Zugnummer: "C6"});

            expect(anfrage_V.Status).toBe('teilweise_bestaetigt_topf');
            expect(anfrage_V.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('abgelehnt_topf_verzichtet');
            expect(anfrage_V.ZugewieseneSlots[1].statusEinzelzuweisung).toBe('bestaetigt_topf');

            expect(anfrage_E1.Status).toBe('teilweise_bestaetigt_topf');
            expect(anfrage_E1.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('abgelehnt_topf_entgelt');
            expect(anfrage_E1.ZugewieseneSlots[1].statusEinzelzuweisung).toBe('bestaetigt_topf');

            expect(anfrage_E2.Status).toBe('vollstaendig_bestaetigt_topf');
            expect(anfrage_E2.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('bestaetigt_topf_entgelt');
            expect(anfrage_E2.ZugewieseneSlots[1].statusEinzelzuweisung).toBe('bestaetigt_topf');

            expect(anfrage_H1.Status).toBe('in_konfliktloesung_topf');
            expect(anfrage_H1.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('wartet_hoechstpreis_topf');
            expect(anfrage_H1.ZugewieseneSlots[1].statusEinzelzuweisung).toBe('bestaetigt_topf');

            expect(anfrage_H2.Status).toBe('in_konfliktloesung_topf');
            expect(anfrage_H2.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('wartet_hoechstpreis_topf');
            expect(anfrage_H2.ZugewieseneSlots[1].statusEinzelzuweisung).toBe('bestaetigt_topf');

            expect(anfrage_H3.Status).toBe('in_konfliktloesung_topf');
            expect(anfrage_H3.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('wartet_hoechstpreis_topf');
            expect(anfrage_H3.ZugewieseneSlots[1].statusEinzelzuweisung).toBe('bestaetigt_topf');

            response = await request(app)
                .post('/api/konflikte/identifiziere-topf-konflikte')
                .send();

            // ---- ÜBERPRÜFUNG ----
            expect(response.status).toBe(200);

            anzahlGruppen = await KonfliktGruppe.countDocuments();
            expect(anzahlGruppen).toBe(1);
            gruppe = await KonfliktGruppe.findOne({ beteiligteAnfragen: anfrage_V._id });
            expect(gruppe).not.toBeNull();
            expect(gruppe.status).toBe('in_bearbeitung_hoechstpreis');

            //Prüfe den Status aller Anfragen
            anfrage_V = await Anfrage.findOne({Zugnummer: "C1"});
            anfrage_E1 = await Anfrage.findOne({Zugnummer: "C2"});
            anfrage_E2 = await Anfrage.findOne({Zugnummer: "C3"});
            anfrage_H1 = await Anfrage.findOne({Zugnummer: "C4"});
            anfrage_H2 = await Anfrage.findOne({Zugnummer: "C5"});
            anfrage_H3 = await Anfrage.findOne({Zugnummer: "C6"});

            expect(anfrage_V.Status).toBe('teilweise_bestaetigt_topf');
            expect(anfrage_V.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('abgelehnt_topf_verzichtet');
            expect(anfrage_V.ZugewieseneSlots[1].statusEinzelzuweisung).toBe('bestaetigt_topf');

            expect(anfrage_E1.Status).toBe('teilweise_bestaetigt_topf');
            expect(anfrage_E1.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('abgelehnt_topf_entgelt');
            expect(anfrage_E1.ZugewieseneSlots[1].statusEinzelzuweisung).toBe('bestaetigt_topf');

            expect(anfrage_E2.Status).toBe('vollstaendig_bestaetigt_topf');
            expect(anfrage_E2.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('bestaetigt_topf_entgelt');
            expect(anfrage_E2.ZugewieseneSlots[1].statusEinzelzuweisung).toBe('bestaetigt_topf');

            expect(anfrage_H1.Status).toBe('in_konfliktloesung_topf');
            expect(anfrage_H1.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('wartet_hoechstpreis_topf');
            expect(anfrage_H1.ZugewieseneSlots[1].statusEinzelzuweisung).toBe('bestaetigt_topf');

            expect(anfrage_H2.Status).toBe('in_konfliktloesung_topf');
            expect(anfrage_H2.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('wartet_hoechstpreis_topf');
            expect(anfrage_H2.ZugewieseneSlots[1].statusEinzelzuweisung).toBe('bestaetigt_topf');

            expect(anfrage_H3.Status).toBe('in_konfliktloesung_topf');
            expect(anfrage_H3.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('wartet_hoechstpreis_topf');
            expect(anfrage_H3.ZugewieseneSlots[1].statusEinzelzuweisung).toBe('bestaetigt_topf');

            // 6. Ergebnisse des Höchstpreisverfahrens senden und erneut Konfliktanalyse starten  
            const hoechstpreisPayload = {
                ListeGeboteHoechstpreis: [
                    { anfrage: anfrage_H1._id.toString(), gebot: 2500 }, // H1 bietet 2500, H2 bitete 1500, H3 gibt kein Gebot ab
                    { anfrage: anfrage_H2._id.toString(), gebot: 1500 },
                ]
            };

            loesenResponse = await request(app)
                .put(`/api/konflikte/gruppen/${gruppe._id}/hoechstpreis-ergebnis`)
                .send(hoechstpreisPayload);

            // Überprüfung
            expect(loesenResponse.status).toBe(200);
            gruppe = await KonfliktGruppe.findOne({ beteiligteAnfragen: anfrage_V._id });
            expect(gruppe).not.toBeNull();
            expect(gruppe.status).toBe('vollstaendig_geloest');

            //Prüfe den Status aller Anfragen
            anfrage_V = await Anfrage.findOne({Zugnummer: "C1"});
            anfrage_E1 = await Anfrage.findOne({Zugnummer: "C2"});
            anfrage_E2 = await Anfrage.findOne({Zugnummer: "C3"});
            anfrage_H1 = await Anfrage.findOne({Zugnummer: "C4"});
            anfrage_H2 = await Anfrage.findOne({Zugnummer: "C5"});
            anfrage_H3 = await Anfrage.findOne({Zugnummer: "C6"});

            expect(anfrage_V.Status).toBe('teilweise_bestaetigt_topf');
            expect(anfrage_V.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('abgelehnt_topf_verzichtet');
            expect(anfrage_V.ZugewieseneSlots[1].statusEinzelzuweisung).toBe('bestaetigt_topf');

            expect(anfrage_E1.Status).toBe('teilweise_bestaetigt_topf');
            expect(anfrage_E1.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('abgelehnt_topf_entgelt');
            expect(anfrage_E1.ZugewieseneSlots[1].statusEinzelzuweisung).toBe('bestaetigt_topf');

            expect(anfrage_E2.Status).toBe('vollstaendig_bestaetigt_topf');
            expect(anfrage_E2.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('bestaetigt_topf_entgelt');
            expect(anfrage_E2.ZugewieseneSlots[1].statusEinzelzuweisung).toBe('bestaetigt_topf');

            expect(anfrage_H1.Status).toBe('vollstaendig_bestaetigt_topf');
            expect(anfrage_H1.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('bestaetigt_topf_hoechstpreis');
            expect(anfrage_H1.ZugewieseneSlots[1].statusEinzelzuweisung).toBe('bestaetigt_topf');

            expect(anfrage_H2.Status).toBe('teilweise_bestaetigt_topf');
            expect(anfrage_H2.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('abgelehnt_topf_hoechstpreis');
            expect(anfrage_H2.ZugewieseneSlots[1].statusEinzelzuweisung).toBe('bestaetigt_topf');

            expect(anfrage_H3.Status).toBe('teilweise_bestaetigt_topf');
            expect(anfrage_H3.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('abgelehnt_topf_hoechstpreis_kein_gebot');
            expect(anfrage_H3.ZugewieseneSlots[1].statusEinzelzuweisung).toBe('bestaetigt_topf');

            response = await request(app)
                .post('/api/konflikte/identifiziere-topf-konflikte')
                .send();

            // ---- ÜBERPRÜFUNG ----
            expect(response.status).toBe(200);

            anzahlGruppen = await KonfliktGruppe.countDocuments();
            expect(anzahlGruppen).toBe(1);
            gruppe = await KonfliktGruppe.findOne({ beteiligteAnfragen: anfrage_V._id });
            expect(gruppe).not.toBeNull();
            expect(gruppe.status).toBe('vollstaendig_geloest');

            //Prüfe den Status aller Anfragen
            anfrage_V = await Anfrage.findOne({Zugnummer: "C1"});
            anfrage_E1 = await Anfrage.findOne({Zugnummer: "C2"});
            anfrage_E2 = await Anfrage.findOne({Zugnummer: "C3"});
            anfrage_H1 = await Anfrage.findOne({Zugnummer: "C4"});
            anfrage_H2 = await Anfrage.findOne({Zugnummer: "C5"});
            anfrage_H3 = await Anfrage.findOne({Zugnummer: "C6"});

            expect(anfrage_V.Status).toBe('teilweise_bestaetigt_topf');
            expect(anfrage_V.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('abgelehnt_topf_verzichtet');
            expect(anfrage_V.ZugewieseneSlots[1].statusEinzelzuweisung).toBe('bestaetigt_topf');

            expect(anfrage_E1.Status).toBe('teilweise_bestaetigt_topf');
            expect(anfrage_E1.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('abgelehnt_topf_entgelt');
            expect(anfrage_E1.ZugewieseneSlots[1].statusEinzelzuweisung).toBe('bestaetigt_topf');

            expect(anfrage_E2.Status).toBe('vollstaendig_bestaetigt_topf');
            expect(anfrage_E2.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('bestaetigt_topf_entgelt');
            expect(anfrage_E2.ZugewieseneSlots[1].statusEinzelzuweisung).toBe('bestaetigt_topf');

            expect(anfrage_H1.Status).toBe('vollstaendig_bestaetigt_topf');
            expect(anfrage_H1.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('bestaetigt_topf_hoechstpreis');
            expect(anfrage_H1.ZugewieseneSlots[1].statusEinzelzuweisung).toBe('bestaetigt_topf');

            expect(anfrage_H2.Status).toBe('teilweise_bestaetigt_topf');
            expect(anfrage_H2.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('abgelehnt_topf_hoechstpreis');
            expect(anfrage_H2.ZugewieseneSlots[1].statusEinzelzuweisung).toBe('bestaetigt_topf');

            expect(anfrage_H3.Status).toBe('teilweise_bestaetigt_topf');
            expect(anfrage_H3.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('abgelehnt_topf_hoechstpreis_kein_gebot');
            expect(anfrage_H3.ZugewieseneSlots[1].statusEinzelzuweisung).toBe('bestaetigt_topf');
        });
});

describe('Konfliktgruppen-Status-Synchronisation (Slot-Konflikte) bei Nacht-Slots', () => {
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

            const slotData3 = {
            slotTyp: "NACHT", von: "C", bis: "D", Abschnitt: "Strecke3", 
            Verkehrstag: "täglich", 
            zeitraumStart: '2025-07-07',  
            zeitraumEnde: '2025-08-03',  
            Grundentgelt: 100,
            Zeitfenster: '03-05',
            Mindestfahrzeit: 60,
            Maximalfahrzeit: 90
            };

            const slotData4 = {
            slotTyp: "TAG", von: "D", bis: "E", Abschnitt: "Strecke4",             
            Verkehrstag: "täglich",       
            zeitraumStart: '2025-07-07',  
            zeitraumEnde: '2025-08-03',  
            Verkehrsart: "SGV",  
            Grundentgelt: 100
            };

             //3 Nacht-Slots auf C-D --> Kapazität von 2
            response = await request(app)
                .post('/api/slots/massen-erstellung')
                .send(slotData3);
            expect(response.status).toBe(201);
            expect(response.body.erstellteSlots).toBeDefined();
            response = await request(app)
                .post('/api/slots/massen-erstellung')
                .send(slotData3);
            expect(response.status).toBe(201);
            expect(response.body.erstellteSlots).toBeDefined();
            response = await request(app)
                .post('/api/slots/massen-erstellung')
                .send(slotData3);
            expect(response.status).toBe(201);
            expect(response.body.erstellteSlots).toBeDefined();
            
            // 5 Tages-Slots auf D-E --> Kapazität von 3
            response = await request(app)
                .post('/api/slots/massen-erstellung')
                .send({...slotData4, Abfahrt: { stunde: 5, minute: 3 }, Ankunft: { stunde: 6, minute: 49 },});
            expect(response.status).toBe(201);
            expect(response.body.erstellteSlots).toBeDefined();
            response = await request(app)
                .post('/api/slots/massen-erstellung')
                .send({...slotData4, Abfahrt: { stunde: 5, minute: 13 }, Ankunft: { stunde: 6, minute: 59 },});
            expect(response.status).toBe(201);
            expect(response.body.erstellteSlots).toBeDefined();
            response = await request(app)
                .post('/api/slots/massen-erstellung')
                .send({...slotData4, Abfahrt: { stunde: 5, minute: 23 }, Ankunft: { stunde: 7, minute: 9 },});
            expect(response.status).toBe(201);
            expect(response.body.erstellteSlots).toBeDefined();
            response = await request(app)
                .post('/api/slots/massen-erstellung')
                .send({...slotData4, Abfahrt: { stunde: 5, minute: 33 }, Ankunft: { stunde: 7, minute: 19 },});
            expect(response.status).toBe(201);
            expect(response.body.erstellteSlots).toBeDefined();
            response = await request(app)
                .post('/api/slots/massen-erstellung')
                .send({...slotData4, Abfahrt: { stunde: 5, minute: 43 }, Ankunft: { stunde: 7, minute: 29 },});
            expect(response.status).toBe(201);
            expect(response.body.erstellteSlots).toBeDefined();

            kt_all = await Kapazitaetstopf.find({});
            expect(kt_all.length).toBe(16);
        });
        it('sollte den Status der Gruppe und der Anfragen auch bei mehrmaliger Konfliktanalyse der Slot-Konflikte in der Nacht korrekt beibehalten', async () => {
            // 2 Anfragen stellen, die im Nacht-Kapazitätstopf übereinander liegen aber im Tages-Zeitraum keinen Konflikt haben
            const anfrageBasis = { Email: "conflict@evu.com", Verkehrsart: "SGV", Verkehrstag: "Mo-Fr", Zeitraum: { start: "2025-07-14", ende: "2025-07-27" }, Status: 'validiert'}; // KW29+30 2025
            
            let anfrage_V1 = await new Anfrage({ ...anfrageBasis, EVU: "ConflictEVU1" , Zugnummer: "C1", 
                                            ListeGewuenschterSlotAbschnitte: [ 
                                                {von: "C", bis:"D", Abfahrtszeit: {stunde:3, minute:45 }, Ankunftszeit:{stunde:4,minute:53}},
                                                {von: "D", bis:"E", Abfahrtszeit: {stunde:5, minute:3 }, Ankunftszeit:{stunde:6,minute:49}}
                                            ]
                                        }).save();
                                    
            let anfrage_V2 = await new Anfrage({ ...anfrageBasis, EVU: "ConflictEVU2" , Zugnummer: "C2", 
                                            ListeGewuenschterSlotAbschnitte: [ 
                                                {von: "C", bis:"D", Abfahrtszeit: {stunde:3, minute:40 }, Ankunftszeit:{stunde:4,minute:59}},
                                                {von: "D", bis:"E", Abfahrtszeit: {stunde:5, minute:13 }, Ankunftszeit:{stunde:6,minute:59}}
                                            ]
                                        }).save();

            anfrage_V1 = await Anfrage.findOne({Zugnummer: "C1"});
            anfrage_V2 = await Anfrage.findOne({Zugnummer: "C2"});           
            

            await request(app).post(`/api/anfragen/${anfrage_V1._id}/zuordnen`).send();
            await request(app).post(`/api/anfragen/${anfrage_V2._id}/zuordnen`).send();

            anfrage_V1 = await Anfrage.findOne({Zugnummer: "C1"});
            anfrage_V1.Status = 'validiert'; anfrage_V1.save();
            anfrage_V2 = await Anfrage.findOne({Zugnummer: "C2"});
            anfrage_V2.Status = 'validiert'; anfrage_V2.save();

            // 3. Erstelle ein Konfliktdokument für die Nacht
            let response = await request(app)
                .post('/api/konflikte/identifiziere-topf-konflikte')
                .send();
            
            // ---- ÜBERPRÜFUNG ----
            expect(response.status).toBe(200);

            // Es gibt keinen Topf-Konflikt, weder in der Nacht, noch am Tag
            let anzahlGruppen = await KonfliktGruppe.countDocuments();
            expect(anzahlGruppen).toBe(0);

            //Prüfung Einzelstatus der Anfragen
            anfrage_V1 = await Anfrage.findOne({Zugnummer: "C1"});
            anfrage_V2 = await Anfrage.findOne({Zugnummer: "C2"}); 

            expect(anfrage_V1.Status).toBe('vollstaendig_bestaetigt_topf');
            expect(anfrage_V1.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('bestaetigt_topf');
            expect(anfrage_V1.ZugewieseneSlots[1].statusEinzelzuweisung).toBe('bestaetigt_topf');

            expect(anfrage_V2.Status).toBe('vollstaendig_bestaetigt_topf');
            expect(anfrage_V2.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('bestaetigt_topf');
            expect(anfrage_V2.ZugewieseneSlots[1].statusEinzelzuweisung).toBe('bestaetigt_topf');

            //Erneute Konfliktprüfung darf keine anderes Ergebnis haben
            response = await request(app)
                .post('/api/konflikte/identifiziere-topf-konflikte')
                .send();
            
            // ---- ÜBERPRÜFUNG ----
            expect(response.status).toBe(200);

            // Es gibt keinen Topf-Konflikt, weder in der Nacht, noch am Tag
            anzahlGruppen = await KonfliktGruppe.countDocuments();
            expect(anzahlGruppen).toBe(0);

            //Prüfung Einzelstatus der Anfragen
            anfrage_V1 = await Anfrage.findOne({Zugnummer: "C1"});
            anfrage_V2 = await Anfrage.findOne({Zugnummer: "C2"}); 

            expect(anfrage_V1.Status).toBe('vollstaendig_bestaetigt_topf');
            expect(anfrage_V1.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('bestaetigt_topf');
            expect(anfrage_V1.ZugewieseneSlots[1].statusEinzelzuweisung).toBe('bestaetigt_topf');

            expect(anfrage_V2.Status).toBe('vollstaendig_bestaetigt_topf');
            expect(anfrage_V2.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('bestaetigt_topf');
            expect(anfrage_V2.ZugewieseneSlots[1].statusEinzelzuweisung).toBe('bestaetigt_topf');

            // Löse jetzt die Slot-Konflikte: In der Nacht werden alles Slots pauschal bestätigt --> also kein Konflikt
            // Am Tag im Abschitt D-E gibt es keinen Slot-Konflikt
            response = await request(app)
                    .post('/api/konflikte/identifiziere-slot-konflikte')
                    .send();

            // Überprüfung der Antwort
            expect(response.status).toBe(200);
            expect(response.body.message).toBe('Konfliktdetektion für Slots abgeschlossen.');
            expect(response.body.neuErstellteKonflikte).toHaveLength(0);
            expect(response.body.aktualisierteUndGeoeffneteKonflikte).toHaveLength(0);
            expect(response.body.unveraenderteBestehendeKonflikte).toHaveLength(0);
            expect(response.body.autoGeloesteKonflikte).toHaveLength(0);
            expect(response.body.slotsOhneKonflikt).toHaveLength(64);

            //Prüfung Einzelstatus der Anfragen
            anfrage_V1 = await Anfrage.findOne({Zugnummer: "C1"});
            anfrage_V2 = await Anfrage.findOne({Zugnummer: "C2"}); 

            expect(anfrage_V1.Status).toBe('vollstaendig_final_bestaetigt');
            expect(anfrage_V1.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('bestaetigt_slot');
            expect(anfrage_V1.ZugewieseneSlots[1].statusEinzelzuweisung).toBe('bestaetigt_slot');

            expect(anfrage_V2.Status).toBe('vollstaendig_final_bestaetigt');
            expect(anfrage_V2.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('bestaetigt_slot');
            expect(anfrage_V2.ZugewieseneSlots[1].statusEinzelzuweisung).toBe('bestaetigt_slot');

            //Erneute Konfliktprüfung darf keine anderes Ergebnis haben
            response = await request(app)
                .post('/api/konflikte/identifiziere-topf-konflikte')
                .send();
            
            // ---- ÜBERPRÜFUNG ----
            expect(response.status).toBe(200);

            // Es gibt keinen Topf-Konflikt, weder in der Nacht, noch am Tag
            anzahlGruppen = await KonfliktGruppe.countDocuments();
            expect(anzahlGruppen).toBe(0);

            //Prüfung Einzelstatus der Anfragen
            anfrage_V1 = await Anfrage.findOne({Zugnummer: "C1"});
            anfrage_V2 = await Anfrage.findOne({Zugnummer: "C2"}); 

            expect(anfrage_V1.Status).toBe('vollstaendig_final_bestaetigt');
            expect(anfrage_V1.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('bestaetigt_slot');
            expect(anfrage_V1.ZugewieseneSlots[1].statusEinzelzuweisung).toBe('bestaetigt_slot');

            expect(anfrage_V2.Status).toBe('vollstaendig_final_bestaetigt');
            expect(anfrage_V2.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('bestaetigt_slot');
            expect(anfrage_V2.ZugewieseneSlots[1].statusEinzelzuweisung).toBe('bestaetigt_slot');

            // Erneute Konfliktprüfung darf keine anderes Ergebnis haben
            response = await request(app)
                    .post('/api/konflikte/identifiziere-slot-konflikte')
                    .send();

            // Überprüfung der Antwort
            expect(response.status).toBe(200);
            // Es gibt keinen Slot-Konflikt, weder in der Nacht, noch am Tag
            anzahlGruppen = await KonfliktGruppe.countDocuments();
            expect(anzahlGruppen).toBe(0);

            //Prüfung Einzelstatus der Anfragen
            anfrage_V1 = await Anfrage.findOne({Zugnummer: "C1"});
            anfrage_V2 = await Anfrage.findOne({Zugnummer: "C2"}); 

            expect(anfrage_V1.Status).toBe('vollstaendig_final_bestaetigt');
            expect(anfrage_V1.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('bestaetigt_slot');
            expect(anfrage_V1.ZugewieseneSlots[1].statusEinzelzuweisung).toBe('bestaetigt_slot');

            expect(anfrage_V2.Status).toBe('vollstaendig_final_bestaetigt');
            expect(anfrage_V2.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('bestaetigt_slot');
            expect(anfrage_V2.ZugewieseneSlots[1].statusEinzelzuweisung).toBe('bestaetigt_slot');

        });
});
