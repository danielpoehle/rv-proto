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

        // Wir definieren die 6 einzigartigen fahrbaren Wege (Kind-Slots)
        const patternsToCreate = [
            // 3 Muster für Abschnitt "Gruppen-Strecke1"
            { elternSlotTyp: 'TAG', alternative: { von: "Gruppenstadt-A", bis: "Gruppenstadt-B", Abschnitt: "Gruppen-Strecke1", Verkehrsart: "SPFV", Grundentgelt: grundentgelt, Abfahrt: { stunde: 9, minute: 0 }, Ankunft: { stunde: 10, minute: 0 } } },
            { elternSlotTyp: 'TAG', alternative: { von: "Gruppenstadt-A", bis: "Gruppenstadt-B", Abschnitt: "Gruppen-Strecke1", Verkehrsart: "SPFV", Grundentgelt: grundentgelt, Abfahrt: { stunde: 9, minute: 10 }, Ankunft: { stunde: 10, minute: 10 } } },
            { elternSlotTyp: 'TAG', alternative: { von: "Gruppenstadt-A", bis: "Gruppenstadt-B", Abschnitt: "Gruppen-Strecke1", Verkehrsart: "SPFV", Grundentgelt: grundentgelt, Abfahrt: { stunde: 9, minute: 20 }, Ankunft: { stunde: 10, minute: 20 } } },
            // 3 Muster für Abschnitt "Gruppen-Strecke2"
            { elternSlotTyp: 'TAG', alternative: { von: "Gruppenstadt-B", bis: "Gruppenstadt-C", Abschnitt: "Gruppen-Strecke2", Verkehrsart: "SPFV", Grundentgelt: grundentgelt, Abfahrt: { stunde: 10, minute: 0 }, Ankunft: { stunde: 11, minute: 0 } } },
            { elternSlotTyp: 'TAG', alternative: { von: "Gruppenstadt-B", bis: "Gruppenstadt-C", Abschnitt: "Gruppen-Strecke2", Verkehrsart: "SPFV", Grundentgelt: grundentgelt, Abfahrt: { stunde: 10, minute: 10 }, Ankunft: { stunde: 11, minute: 10 } } },
            { elternSlotTyp: 'TAG', alternative: { von: "Gruppenstadt-B", bis: "Gruppenstadt-C", Abschnitt: "Gruppen-Strecke2", Verkehrsart: "SPFV", Grundentgelt: grundentgelt, Abfahrt: { stunde: 10, minute: 20 }, Ankunft: { stunde: 11, minute: 20 } } },
        ];

        const kalenderwochen = Array.from({ length: anzahlWochen }, (_, i) => i + 1); // Erzeugt [1, 2, 3]
        const verkehrstage = ["Mo-Fr", "Sa+So"];
        const erstellteElternSlots = [];

        // ----- 2. Erstelle alle 36 Slot-Gruppen in verschachtelten Schleifen -----

        for (const pattern of patternsToCreate) {
            for (const kw of kalenderwochen) {
                for (const vt of verkehrstage) {
                    // Baue den korrekten, verschachtelten Payload für die API
                    const payload = {
                        elternSlotTyp: pattern.elternSlotTyp,
                        Kalenderwoche: kw,
                        Verkehrstag: vt,
                        Abschnitt: pattern.alternative.Abschnitt,
                        alternativen: [
                            pattern.alternative
                        ]
                    };

                    // Sende den Payload an den API-Endpunkt
                    const response = await request(app)
                        .post('/api/slots')
                        .send(payload);

                    expect(response.status).toBe(201);
                    erstellteElternSlots.push(response.body.data);
                }
            }
        }

        // ----- 3. Finale Überprüfung -----
        const alleSlotsDB = await Slot.find({});
        // Es sollten 36 Eltern-Slots und 36 Kind-Slots erstellt worden sein
        expect(alleSlotsDB.filter(s => s.slotStrukturTyp === 'ELTERN')).toHaveLength(36);
        expect(alleSlotsDB.filter(s => s.slotStrukturTyp === 'KIND')).toHaveLength(36);

        // Überprüfe stichprobenartig einen der erstellten Kapazitätstöpfe
        const topfCheck = await Kapazitaetstopf.findOne({ Abschnitt: "Gruppen-Strecke1", Kalenderwoche: 1, Verkehrstag: "Mo-Fr" });
        expect(topfCheck).toBeDefined();
        // In diesem Topf sollten 3 Eltern-Slots sein
        expect(topfCheck.ListeDerSlots).toHaveLength(3);
        // Die Kapazität sollte korrekt berechnet sein
        expect(topfCheck.maxKapazitaet).toBe(2); // floor(0.7 * 3) = 2

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
    it('sollte eine Gruppenentscheidung Verzicht korrekt auf alle 12 Topf-Konflikte anwenden und diese loesen', async () => {
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
    it('sollte eine Gruppenentscheidung Entgeltvergleich eindeutig korrekt auf alle 12 Topf-Konflikte anwenden und diese loesen', async () => {
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
    it('sollte eine Gruppenentscheidung Entgeltvergleich Gleichstand korrekt auf alle 12 Topf-Konflikte anwenden und diese als ungeloest markieren', async () => {
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
    it('sollte eine Gruppenentscheidung Hoechstpreisverfahren korrekt auf alle 12 Topf-Konflikte anwenden und diese loesen', async () => {
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

        it('sollte den Gruppenstatus auf invalide setzen, wenn die Einzelkonflikte bei gleicher Kapazitaet der Toepfe unterschiedliche Status haben', async () => {
            // ---- SETUP: Erzeuge zwei Konflikte mit identischen Anfragen, aber unterschiedlichem Status ----

            // Die zwei unterschiedlichen KIND-Muster, die wir erstellen wollen
            const kindPatterns = [
                {
                    von: "S", bis: "T", Abschnitt: "Sued",
                    Abfahrt: { stunde: 9, minute: 0 }, Ankunft: { stunde: 10, minute: 0 },
                    Verkehrsart: "SPFV", Grundentgelt: 150
                },
                {
                    von: "S", bis: "T", Abschnitt: "Sued",
                    Abfahrt: { stunde: 9, minute: 10 }, Ankunft: { stunde: 10, minute: 10 },
                    Verkehrsart: "SPFV", Grundentgelt: 150
                }
            ];

            // Definiere die variablen Eigenschaften
            const kalenderwochen = [11, 12];
            const verkehrstag = "Mo-Fr";

            // Ein Objekt, um die erstellten Slots für den zweiten Teil des Tests leicht zu finden
            const erstellteSlots = {};

            // ----- 2. Erstelle die 4 Slot-Gruppen (2 Muster * 2 KWs) in einer Schleife -----

            for (const pattern of kindPatterns) {
                for (const kw of kalenderwochen) {
                    const payload = {
                        elternSlotTyp: "TAG",
                        Kalenderwoche: kw,
                        Verkehrstag: verkehrstag,
                        Abschnitt: "Sued",
                        alternativen: [pattern]
                    };

                    const response = await request(app).post('/api/slots').send(payload);
                    expect(response.status).toBe(201);
                    
                    // Speichere den zurückgegebenen Eltern-Slot (populiert mit dem Kind) für den nächsten Schritt
                    // Wir erstellen einen eindeutigen Schlüssel zum einfachen Wiederfinden
                    const key = `KW${kw}_${pattern.Abfahrt.stunde}${String(pattern.Abfahrt.minute).padStart(2, '0')}`;
                    erstellteSlots[key] = response.body.data;
                }
            }
            expect(Object.keys(erstellteSlots).length).toBe(4);

            // ----- 3. Lade die Kapazitätstöpfe (optional, zur Verifizierung) -----
            const kt_A = await Kapazitaetstopf.findOne({ Kalenderwoche: 11, Abschnitt: "Sued" });
            const kt_B = await Kapazitaetstopf.findOne({ Kalenderwoche: 12, Abschnitt: "Sued" });
            expect(kt_A.ListeDerSlots).toHaveLength(2); // Beide Muster fallen in denselben Topf
            expect(kt_B.ListeDerSlots).toHaveLength(2);
            expect(kt_A.maxKapazitaet).toBe(1);
            expect(kt_B.maxKapazitaet).toBe(1);

            // ----- 4. Erstelle die Anfragen mit der korrekten Eltern-Kind-Struktur -----

            // Finde die spezifischen Eltern- und Kind-Slots, die von den Anfragen gewünscht werden (die um 9:00 Uhr)
            const elternSlotKW11 = erstellteSlots['KW11_900'];
            const kindSlotKW11_Id = elternSlotKW11.gabelAlternativen[0]._id;

            const elternSlotKW12 = erstellteSlots['KW12_900'];
            const kindSlotKW12_Id = elternSlotKW12.gabelAlternativen[0]._id;

            // Bereite das ZugewieseneSlots-Array für die Anfragen vor
            const zugewieseneSlotsFuerAnfrage = [
                { 
                    slot: elternSlotKW11._id, // Verweis auf den ELTERN-Slot
                    kind: kindSlotKW11_Id,      // Verweis auf den KIND-Slot
                    statusEinzelzuweisung: 'wartet_konflikt_topf' 
                },
                { 
                    slot: elternSlotKW12._id, // Verweis auf den ELTERN-Slot
                    kind: kindSlotKW12_Id,      // Verweis auf den KIND-Slot
                    statusEinzelzuweisung: 'wartet_konflikt_topf' 
                }
            ];

            const anfrageBasis = {
                EVU: "Inv", Verkehrsart: "SPFV", Verkehrstag: "Mo-Fr", 
                Zeitraum: { start: "2025-03-10", ende: "2025-03-23" }, // KW 11 & 12
                ListeGewuenschterSlotAbschnitte: [{von:"S", bis:"T", Abfahrtszeit:{stunde:9,minute:0}, Ankunftszeit:{stunde:10,minute:0}}], 
                Email: 'rv@evu.de',
                Status: 'validiert'
            };

            // Erstelle die beiden Anfragen
            await new Anfrage({ 
                ...anfrageBasis, 
                Zugnummer: "X1", 
                EVU: "Inv1",
                ZugewieseneSlots: zugewieseneSlotsFuerAnfrage
            }).save();

            await new Anfrage({ 
                ...anfrageBasis, 
                Zugnummer: "Y1", 
                EVU: "Inv2",
                ZugewieseneSlots: zugewieseneSlotsFuerAnfrage 
            }).save();

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

        it('sollte bei zwei Kapazitaetstoepfen mit unterschiedlicher Kapazitaet bei gleichen Anfragen zwei Gruppen bilden', async () => {
            // ---- SETUP: Erzeuge zwei Konflikte mit identischen Anfragen, aber unterschiedlichem Kapazitäten in den Töpfen ----

            // Es gibt 2 Slot-Muster für Abschnitt "Sued" und 3 für Abschnitt "West"
            const slotPatterns = [
                // Abschnitt Sued (insgesamt 2 Muster)
                { elternSlotTyp: "TAG", alternative: { von: "S", bis: "T", Abschnitt: "Sued", Abfahrt: { stunde: 9, minute: 0 }, Ankunft: { stunde: 10, minute: 0 }, Verkehrsart: "SPFV", Grundentgelt: 150 } },
                { elternSlotTyp: "TAG", alternative: { von: "S", bis: "T", Abschnitt: "Sued", Abfahrt: { stunde: 9, minute: 10 }, Ankunft: { stunde: 10, minute: 10 }, Verkehrsart: "SPFV", Grundentgelt: 150 } },
                // Abschnitt West (insgesamt 3 Muster)
                { elternSlotTyp: "TAG", alternative: { von: "X", bis: "S", Abschnitt: "West", Abfahrt: { stunde: 8, minute: 0 }, Ankunft: { stunde: 8, minute: 45 }, Verkehrsart: "SPFV", Grundentgelt: 120 } },
                { elternSlotTyp: "TAG", alternative: { von: "X", bis: "S", Abschnitt: "West", Abfahrt: { stunde: 8, minute: 5 }, Ankunft: { stunde: 8, minute: 50 }, Verkehrsart: "SPFV", Grundentgelt: 120 } },
                { elternSlotTyp: "TAG", alternative: { von: "X", bis: "S", Abschnitt: "West", Abfahrt: { stunde: 8, minute: 10 }, Ankunft: { stunde: 8, minute: 55 }, Verkehrsart: "SPFV", Grundentgelt: 120 } },
            ];

            const kalenderwochen = [11, 12];
            const verkehrstag = "Mo-Fr";

            // Ein Objekt, um die erstellten Slots für den nächsten Schritt leicht zu finden
            const erstellteElternSlots = {};

            // ----- 2. Erstelle alle 10 Slot-Gruppen (5 Muster * 2 KWs) -----

            for (const pattern of slotPatterns) {
                for (const kw of kalenderwochen) {
                    const payload = {
                        elternSlotTyp: pattern.elternSlotTyp,
                        Kalenderwoche: kw,
                        Verkehrstag: verkehrstag,
                        Abschnitt: pattern.alternative.Abschnitt,
                        alternativen: [pattern.alternative]
                    };
                    const response = await request(app).post('/api/slots').send(payload);
                    expect(response.status).toBe(201);

                    // Speichere den Eltern-Slot mit einem eindeutigen Schlüssel
                    const key = `${pattern.alternative.Abschnitt}_KW${kw}_${pattern.alternative.Abfahrt.stunde}${String(pattern.alternative.Abfahrt.minute).padStart(2, '0')}`;
                    erstellteElternSlots[key] = response.body.data;
                }
            }
            expect(Object.keys(erstellteElternSlots).length).toBe(10); // 5 Muster * 2 KWs

            // ----- 3. Erstelle die Anfragen mit der korrekten Eltern-Kind-Struktur -----

            // Finde die spezifischen Eltern- und Kind-Slots für die Anfragen
            // Anfragen wollen X->S um 8:00 und S->T um 9:00 in KW 11 und KW 12
            const elternSlot_West_KW11 = erstellteElternSlots['West_KW11_800'];
            const kindSlot_West_KW11_Id = elternSlot_West_KW11.gabelAlternativen[0]._id;
            const elternSlot_Sued_KW11 = erstellteElternSlots['Sued_KW11_900'];
            const kindSlot_Sued_KW11_Id = elternSlot_Sued_KW11.gabelAlternativen[0]._id;

            // Da die Anfragen über mehrere KWs gehen, brauchen wir auch die Slots aus KW12
            const elternSlot_West_KW12 = erstellteElternSlots['West_KW12_800'];
            const kindSlot_West_KW12_Id = elternSlot_West_KW12.gabelAlternativen[0]._id;
            const elternSlot_Sued_KW12 = erstellteElternSlots['Sued_KW12_900'];
            const kindSlot_Sued_KW12_Id = elternSlot_Sued_KW12.gabelAlternativen[0]._id;

            // Bereite das ZugewieseneSlots-Array für die Anfragen vor
            const zugewieseneSlotsFuerAnfrage = [
                { slot: elternSlot_West_KW11._id, kind: kindSlot_West_KW11_Id, statusEinzelzuweisung: 'wartet_konflikt_topf' },
                { slot: elternSlot_Sued_KW11._id, kind: kindSlot_Sued_KW11_Id, statusEinzelzuweisung: 'wartet_konflikt_topf' },
                { slot: elternSlot_West_KW12._id, kind: kindSlot_West_KW12_Id, statusEinzelzuweisung: 'wartet_konflikt_topf' },
                { slot: elternSlot_Sued_KW12._id, kind: kindSlot_Sued_KW12_Id, statusEinzelzuweisung: 'wartet_konflikt_topf' },
            ];

            const anfrageBasis = {
                Verkehrsart: "SPFV", Verkehrstag: "Mo-Fr", 
                Zeitraum: { start: "2025-03-10", ende: "2025-03-23" }, // KW 11 & 12
                ListeGewuenschterSlotAbschnitte: [
                    {von:"X", bis:"S", Abfahrtszeit:{stunde:8,minute:0}, Ankunftszeit:{stunde:8,minute:45}},
                    {von:"S", bis:"T", Abfahrtszeit:{stunde:9,minute:0}, Ankunftszeit:{stunde:10,minute:0}}
                ], 
                Email: 'rv@evu.de',
                Status: 'validiert',
                ZugewieseneSlots: zugewieseneSlotsFuerAnfrage
            };

            // Erstelle die drei Anfragen
            await new Anfrage({ ...anfrageBasis, Zugnummer: "X1", EVU: "Inv3" }).save();
            await new Anfrage({ ...anfrageBasis, Zugnummer: "Y1", EVU: "Inv4" }).save();
            await new Anfrage({ ...anfrageBasis, Zugnummer: "Z1", EVU: "Inv5" }).save();

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

        it('sollte den Status der Gruppe und der Anfragen auch bei mehrmaliger Konfliktanalyse Topf-Konflikte korrekt beibehalten', async () => {
            // ---- SETUP: Erzeuge einen Konflikt mit 2 Kapazitäten und 4 Anfrage, die bis zum Höchstpreis kommen ----

            
            // ----- 1. Vorbereitung: Definiere die zu erstellenden Slot-Muster -----

            // Die drei leicht unterschiedlichen KIND-Muster für den Abschnitt "West"
            const kindPatterns = [
                { von: "X", bis: "S", Abschnitt: "West", Abfahrt: { stunde: 8, minute: 0 }, Ankunft: { stunde: 8, minute: 45 }, Verkehrsart: "SPFV", Grundentgelt: 120 },
                { von: "X", bis: "S", Abschnitt: "West", Abfahrt: { stunde: 8, minute: 5 }, Ankunft: { stunde: 8, minute: 50 }, Verkehrsart: "SPFV", Grundentgelt: 120 },
                { von: "X", bis: "S", Abschnitt: "West", Abfahrt: { stunde: 8, minute: 10 }, Ankunft: { stunde: 8, minute: 55 }, Verkehrsart: "SPFV", Grundentgelt: 120 }
            ];

            const kalenderwochen = [11, 12, 13];
            const verkehrstag = "Mo-Fr";
            const elternSlotTyp = "TAG";

            // Ein Objekt, um die erstellten Slots für den nächsten Schritt leicht zu finden
            const erstellteElternSlots = {};

            // ----- 2. Erstelle alle 9 Slot-Gruppen (3 Muster * 3 KWs) -----

            for (const pattern of kindPatterns) {
                for (const kw of kalenderwochen) {
                    const payload = {
                        elternSlotTyp,
                        Kalenderwoche: kw,
                        Verkehrstag: verkehrstag,
                        Abschnitt: "West",
                        alternativen: [pattern]
                    };
                    const response = await request(app).post('/api/slots').send(payload);
                    expect(response.status).toBe(201);

                    const key = `KW${kw}_${pattern.Abfahrt.stunde}${String(pattern.Abfahrt.minute).padStart(2, '0')}`;
                    erstellteElternSlots[key] = response.body.data;
                }
            }
            expect(Object.keys(erstellteElternSlots).length).toBe(9);

            // ----- 3. Erstelle die Anfragen mit der korrekten Eltern-Kind-Struktur -----

            // Finde die spezifischen Slots (Abfahrt 8:00) für die Anfragen in den jeweiligen KWs
            const elternSlot_KW11 = erstellteElternSlots['KW11_800'];
            const elternSlot_KW12 = erstellteElternSlots['KW12_800'];
            const elternSlot_KW13 = erstellteElternSlots['KW13_800'];

            // Bereite die ZugewieseneSlots-Arrays für die verschiedenen Anfragen vor
            const zugewieseneSlots_3Wochen = [
                { slot: elternSlot_KW11._id, kind: elternSlot_KW11.gabelAlternativen[0]._id, statusEinzelzuweisung: 'wartet_konflikt_topf' },
                { slot: elternSlot_KW12._id, kind: elternSlot_KW12.gabelAlternativen[0]._id, statusEinzelzuweisung: 'wartet_konflikt_topf' },
                { slot: elternSlot_KW13._id, kind: elternSlot_KW13.gabelAlternativen[0]._id, statusEinzelzuweisung: 'wartet_konflikt_topf' }
            ];
            const zugewieseneSlots_2Wochen = zugewieseneSlots_3Wochen.slice(0, 2); // Nur KW 11 & 12

            const anfrageBasis = {
                Verkehrsart: "SPFV", Verkehrstag: "Mo-Fr", 
                ListeGewuenschterSlotAbschnitte: [{von:"X", bis:"S", Abfahrtszeit:{stunde:8,minute:0}, Ankunftszeit:{stunde:8,minute:45}}],
                Status: 'validiert'
            };

            // Erstelle die vier Anfragen
            await new Anfrage({ 
                ...anfrageBasis, Zugnummer: "X1", EVU: "Inv1", Email: 'rv@evu1.de',
                Zeitraum: { start: "2025-03-10", ende: "2025-03-30" }, // 3 Wochen
                ZugewieseneSlots: zugewieseneSlots_3Wochen
            }).save();

            await new Anfrage({ 
                ...anfrageBasis, Zugnummer: "Y1", EVU: "Inv2", Email: 'rv@evu2.de',
                Zeitraum: { start: "2025-03-10", ende: "2025-03-23" }, // 2 Wochen
                ZugewieseneSlots: zugewieseneSlots_2Wochen 
            }).save();

            await new Anfrage({ 
                ...anfrageBasis, Zugnummer: "Z1", EVU: "Inv3", Email: 'rv@evu3.de',
                Zeitraum: { start: "2025-03-10", ende: "2025-03-23" }, // 2 Wochen
                ZugewieseneSlots: zugewieseneSlots_2Wochen
            }).save();

            await new Anfrage({ 
                ...anfrageBasis, Zugnummer: "V1", EVU: "Inv4", Email: 'rv@evu4.de',
                Zeitraum: { start: "2025-03-10", ende: "2025-03-23" }, // 2 Wochen
                ZugewieseneSlots: zugewieseneSlots_2Wochen
            }).save();

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

        it('sollte den max Marktanteil beim Entgeltvergleich korrekt beruecksichtigen Fall 1', async () => {
            // ---- SETUP: Erzeuge einen Konflikt mit 2 Kapazitäten und 4 Anfragen, die bis zum Entgeltvergleich kommen ----

            
            // ----- 1. Vorbereitung: Definiere die zu erstellenden Slot-Muster -----

            // Die drei leicht unterschiedlichen KIND-Muster für den Abschnitt "Nord-West"
            const kindPatterns = [
                { von: "X", bis: "S", Abschnitt: "Nord-West", Abfahrt: { stunde: 8, minute: 0 }, Ankunft: { stunde: 8, minute: 45 }, Verkehrsart: "SPFV", Grundentgelt: 120 },
                { von: "X", bis: "S", Abschnitt: "Nord-West", Abfahrt: { stunde: 8, minute: 5 }, Ankunft: { stunde: 8, minute: 50 }, Verkehrsart: "SPFV", Grundentgelt: 120 },
                { von: "X", bis: "S", Abschnitt: "Nord-West", Abfahrt: { stunde: 8, minute: 10 }, Ankunft: { stunde: 8, minute: 55 }, Verkehrsart: "SPFV", Grundentgelt: 120 }
            ];

            const kalenderwochen = [11, 12, 13];
            const verkehrstag = "Mo-Fr";
            const elternSlotTyp = "TAG";

            // Ein Objekt, um die erstellten Slots für den nächsten Schritt leicht zu finden
            const erstellteElternSlots = {};

            // ----- 2. Erstelle alle 9 Slot-Gruppen (3 Muster * 3 KWs) -----

            for (const pattern of kindPatterns) {
                for (const kw of kalenderwochen) {
                    const payload = {
                        elternSlotTyp,
                        Kalenderwoche: kw,
                        Verkehrstag: verkehrstag,
                        Abschnitt: pattern.Abschnitt,
                        alternativen: [pattern]
                    };
                    const response = await request(app).post('/api/slots').send(payload);
                    expect(response.status).toBe(201);

                    const key = `KW${kw}_${pattern.Abfahrt.stunde}${String(pattern.Abfahrt.minute).padStart(2, '0')}`;
                    erstellteElternSlots[key] = response.body.data;
                }
            }
            expect(Object.keys(erstellteElternSlots).length).toBe(9);

            // ----- 3. Erstelle die Anfragen mit der korrekten Eltern-Kind-Struktur -----

            // Finde die spezifischen Slots (Abfahrt 8:00) für die Anfragen in den jeweiligen KWs
            const elternSlot_KW11 = erstellteElternSlots['KW11_800'];
            const elternSlot_KW12 = erstellteElternSlots['KW12_800'];
            const elternSlot_KW13 = erstellteElternSlots['KW13_800'];

            // Bereite die ZugewieseneSlots-Arrays für die verschiedenen Anfragen vor
            const zugewieseneSlots_3Wochen = [
                { slot: elternSlot_KW11._id, kind: elternSlot_KW11.gabelAlternativen[0]._id, statusEinzelzuweisung: 'wartet_konflikt_topf' },
                { slot: elternSlot_KW12._id, kind: elternSlot_KW12.gabelAlternativen[0]._id, statusEinzelzuweisung: 'wartet_konflikt_topf' },
                { slot: elternSlot_KW13._id, kind: elternSlot_KW13.gabelAlternativen[0]._id, statusEinzelzuweisung: 'wartet_konflikt_topf' }
            ];
            const zugewieseneSlots_2Wochen = zugewieseneSlots_3Wochen.slice(0, 2); // Nur KW 11 & 12

            const anfrageBasis = {
                Verkehrsart: "SPFV", Verkehrstag: "Mo-Fr", 
                ListeGewuenschterSlotAbschnitte: [{von:"X", bis:"S", Abfahrtszeit:{stunde:8,minute:0}, Ankunftszeit:{stunde:8,minute:45}}],
                Status: 'validiert'
            };

            // Erstelle die vier Anfragen
            await new Anfrage({ 
                ...anfrageBasis, Zugnummer: "X1", EVU: "Inv1", Email: 'rv@evu1.de',
                Zeitraum: { start: "2025-03-10", ende: "2025-03-30" }, // 3 Wochen
                ZugewieseneSlots: zugewieseneSlots_3Wochen
            }).save();

            await new Anfrage({ 
                ...anfrageBasis, Zugnummer: "Y1", EVU: "Inv1", Email: 'rv@evu2.de', // Selbes EVU
                Zeitraum: { start: "2025-03-10", ende: "2025-03-23" }, // 2 Wochen
                ZugewieseneSlots: zugewieseneSlots_2Wochen 
            }).save();

            await new Anfrage({ 
                ...anfrageBasis, Zugnummer: "Z1", EVU: "Inv3", Email: 'rv@evu3.de',
                Zeitraum: { start: "2025-03-10", ende: "2025-03-23" }, // 2 Wochen
                ZugewieseneSlots: zugewieseneSlots_2Wochen
            }).save();

            await new Anfrage({ 
                ...anfrageBasis, Zugnummer: "V1", EVU: "Inv4", Email: 'rv@evu4.de',
                Zeitraum: { start: "2025-03-11", ende: "2025-03-23" }, // Anderer Starttag, aber 2 Wochen
                ZugewieseneSlots: zugewieseneSlots_2Wochen
            }).save();

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

        it('sollte den max Marktanteil beim Entgeltvergleich korrekt beruecksichtigen Fall 2', async () => {
            // ---- SETUP: Erzeuge einen Konflikt mit 2 Kapazitäten und 4 Anfragen, die bis zum Entgeltvergleich kommen ----

            
            // ----- 1. Vorbereitung: Definiere die zu erstellenden Slot-Muster -----

            // Die drei leicht unterschiedlichen KIND-Muster für den Abschnitt "Nord-West"
            const kindPatterns = [
                { von: "X", bis: "S", Abschnitt: "Nord-West", Abfahrt: { stunde: 8, minute: 0 }, Ankunft: { stunde: 8, minute: 45 }, Verkehrsart: "SPFV", Grundentgelt: 120 },
                { von: "X", bis: "S", Abschnitt: "Nord-West", Abfahrt: { stunde: 8, minute: 5 }, Ankunft: { stunde: 8, minute: 50 }, Verkehrsart: "SPFV", Grundentgelt: 120 },
                { von: "X", bis: "S", Abschnitt: "Nord-West", Abfahrt: { stunde: 8, minute: 10 }, Ankunft: { stunde: 8, minute: 55 }, Verkehrsart: "SPFV", Grundentgelt: 120 }
            ];

            const kalenderwochen = [11, 12, 13];
            const verkehrstag = "Mo-Fr";
            const elternSlotTyp = "TAG";

            // Ein Objekt, um die erstellten Slots für den nächsten Schritt leicht zu finden
            const erstellteElternSlots = {};

            // ----- 2. Erstelle alle 9 Slot-Gruppen (3 Muster * 3 KWs) -----

            for (const pattern of kindPatterns) {
                for (const kw of kalenderwochen) {
                    const payload = {
                        elternSlotTyp,
                        Kalenderwoche: kw,
                        Verkehrstag: verkehrstag,
                        Abschnitt: pattern.Abschnitt,
                        alternativen: [pattern]
                    };
                    const response = await request(app).post('/api/slots').send(payload);
                    expect(response.status).toBe(201);

                    const key = `KW${kw}_${pattern.Abfahrt.stunde}${String(pattern.Abfahrt.minute).padStart(2, '0')}`;
                    erstellteElternSlots[key] = response.body.data;
                }
            }
            expect(Object.keys(erstellteElternSlots).length).toBe(9);

            // ----- 3. Erstelle die Anfragen mit der korrekten Eltern-Kind-Struktur -----

            // Finde die spezifischen Slots (Abfahrt 8:00) für die Anfragen in den jeweiligen KWs
            const elternSlot_KW11 = erstellteElternSlots['KW11_800'];
            const elternSlot_KW12 = erstellteElternSlots['KW12_800'];
            const elternSlot_KW13 = erstellteElternSlots['KW13_800'];

            // Bereite die ZugewieseneSlots-Arrays für die verschiedenen Anfragen vor
            const zugewieseneSlots_3Wochen = [
                { slot: elternSlot_KW11._id, kind: elternSlot_KW11.gabelAlternativen[0]._id, statusEinzelzuweisung: 'wartet_konflikt_topf' },
                { slot: elternSlot_KW12._id, kind: elternSlot_KW12.gabelAlternativen[0]._id, statusEinzelzuweisung: 'wartet_konflikt_topf' },
                { slot: elternSlot_KW13._id, kind: elternSlot_KW13.gabelAlternativen[0]._id, statusEinzelzuweisung: 'wartet_konflikt_topf' }
            ];
            const zugewieseneSlots_2Wochen = zugewieseneSlots_3Wochen.slice(0, 2); // Nur KW 11 & 12

            const anfrageBasis = {
                Verkehrsart: "SPFV", Verkehrstag: "Mo-Fr", 
                ListeGewuenschterSlotAbschnitte: [{von:"X", bis:"S", Abfahrtszeit:{stunde:8,minute:0}, Ankunftszeit:{stunde:8,minute:45}}],
                Status: 'validiert'
            };

            // Erstelle die vier Anfragen
            await new Anfrage({ 
                ...anfrageBasis, Zugnummer: "X1", EVU: "Inv1", Email: 'rv@evu1.de',
                Zeitraum: { start: "2025-03-10", ende: "2025-03-30" }, // 3 Wochen
                ZugewieseneSlots: zugewieseneSlots_3Wochen
            }).save();

            await new Anfrage({ 
                ...anfrageBasis, Zugnummer: "Y1", EVU: "Inv3", Email: 'rv@evu2.de',
                Zeitraum: { start: "2025-03-10", ende: "2025-03-23" }, // 2 Wochen
                ZugewieseneSlots: zugewieseneSlots_2Wochen 
            }).save();

            await new Anfrage({ 
                ...anfrageBasis, Zugnummer: "Z1", EVU: "Inv3", Email: 'rv@evu3.de',
                Zeitraum: { start: "2025-03-10", ende: "2025-03-23" }, // 2 Wochen
                ZugewieseneSlots: zugewieseneSlots_2Wochen
            }).save();

            await new Anfrage({ 
                ...anfrageBasis, Zugnummer: "V1", EVU: "Inv4", Email: 'rv@evu4.de',
                Zeitraum: { start: "2025-03-11", ende: "2025-03-23" }, // Anderer Starttag, aber 2 Wochen
                ZugewieseneSlots: zugewieseneSlots_2Wochen
            }).save();

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

        it('sollte den max Marktanteil beim Entgeltvergleich korrekt beruecksichtigen Fall 3', async () => {
            // ---- SETUP: Erzeuge einen Konflikt mit 2 Kapazitäten und 4 Anfragen, die bis zum Entgeltvergleich kommen ----

            
            // ----- 1. Vorbereitung: Definiere die zu erstellenden Slot-Muster -----

            // Die drei leicht unterschiedlichen KIND-Muster für den Abschnitt "Nord-West"
            const kindPatterns = [
                { von: "X", bis: "S", Abschnitt: "Nord-West", Abfahrt: { stunde: 8, minute: 0 }, Ankunft: { stunde: 8, minute: 45 }, Verkehrsart: "SPFV", Grundentgelt: 120 },
                { von: "X", bis: "S", Abschnitt: "Nord-West", Abfahrt: { stunde: 8, minute: 5 }, Ankunft: { stunde: 8, minute: 50 }, Verkehrsart: "SPFV", Grundentgelt: 120 },
                { von: "X", bis: "S", Abschnitt: "Nord-West", Abfahrt: { stunde: 8, minute: 10 }, Ankunft: { stunde: 8, minute: 55 }, Verkehrsart: "SPFV", Grundentgelt: 120 }
            ];

            const kalenderwochen = [11, 12, 13];
            const verkehrstag = "Mo-Fr";
            const elternSlotTyp = "TAG";

            // Ein Objekt, um die erstellten Slots für den nächsten Schritt leicht zu finden
            const erstellteElternSlots = {};

            // ----- 2. Erstelle alle 9 Slot-Gruppen (3 Muster * 3 KWs) -----

            for (const pattern of kindPatterns) {
                for (const kw of kalenderwochen) {
                    const payload = {
                        elternSlotTyp,
                        Kalenderwoche: kw,
                        Verkehrstag: verkehrstag,
                        Abschnitt: pattern.Abschnitt,
                        alternativen: [pattern]
                    };
                    const response = await request(app).post('/api/slots').send(payload);
                    expect(response.status).toBe(201);

                    const key = `KW${kw}_${pattern.Abfahrt.stunde}${String(pattern.Abfahrt.minute).padStart(2, '0')}`;
                    erstellteElternSlots[key] = response.body.data;
                }
            }
            expect(Object.keys(erstellteElternSlots).length).toBe(9);

            // ----- 3. Erstelle die Anfragen mit der korrekten Eltern-Kind-Struktur -----

            // Finde die spezifischen Slots (Abfahrt 8:00) für die Anfragen in den jeweiligen KWs
            const elternSlot_KW11 = erstellteElternSlots['KW11_800'];
            const elternSlot_KW12 = erstellteElternSlots['KW12_800'];
            const elternSlot_KW13 = erstellteElternSlots['KW13_800'];

            // Bereite die ZugewieseneSlots-Arrays für die verschiedenen Anfragen vor
            const zugewieseneSlots_3Wochen = [
                { slot: elternSlot_KW11._id, kind: elternSlot_KW11.gabelAlternativen[0]._id, statusEinzelzuweisung: 'wartet_konflikt_topf' },
                { slot: elternSlot_KW12._id, kind: elternSlot_KW12.gabelAlternativen[0]._id, statusEinzelzuweisung: 'wartet_konflikt_topf' },
                { slot: elternSlot_KW13._id, kind: elternSlot_KW13.gabelAlternativen[0]._id, statusEinzelzuweisung: 'wartet_konflikt_topf' }
            ];
            const zugewieseneSlots_2Wochen = zugewieseneSlots_3Wochen.slice(0, 2); // Nur KW 11 & 12

            const anfrageBasis = {
                Verkehrsart: "SPFV", Verkehrstag: "Mo-Fr", 
                ListeGewuenschterSlotAbschnitte: [{von:"X", bis:"S", Abfahrtszeit:{stunde:8,minute:0}, Ankunftszeit:{stunde:8,minute:45}}],
                Status: 'validiert'
            };

            // Erstelle die vier Anfragen
            await new Anfrage({ 
                ...anfrageBasis, Zugnummer: "X1", EVU: "Inv1", Email: 'rv@evu1.de',
                Zeitraum: { start: "2025-03-10", ende: "2025-03-30" }, // 3 Wochen
                ZugewieseneSlots: zugewieseneSlots_3Wochen
            }).save();

            await new Anfrage({ 
                ...anfrageBasis, Zugnummer: "Y1", EVU: "Inv2", Email: 'rv@evu2.de', // Anderes EVU
                Zeitraum: { start: "2025-03-10", ende: "2025-03-23" }, // 2 Wochen
                ZugewieseneSlots: zugewieseneSlots_2Wochen 
            }).save();

            await new Anfrage({ 
                ...anfrageBasis, Zugnummer: "Z1", EVU: "Inv2", Email: 'rv@evu3.de',
                Zeitraum: { start: "2025-03-10", ende: "2025-03-23" }, // 2 Wochen
                ZugewieseneSlots: zugewieseneSlots_2Wochen
            }).save();

            await new Anfrage({ 
                ...anfrageBasis, Zugnummer: "V1", EVU: "Inv1", Email: 'rv@evu4.de',
                Zeitraum: { start: "2025-03-11", ende: "2025-03-23" }, // Anderer Starttag, aber 2 Wochen
                ZugewieseneSlots: zugewieseneSlots_2Wochen
            }).save();

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

        it('sollte den max Marktanteil beim Entgeltvergleich korrekt beruecksichtigen Fall 4', async () => {
            // ---- SETUP: Erzeuge einen Konflikt mit 2 Kapazitäten und 4 Anfragen, die bis zum Entgeltvergleich kommen ----

            
            // ----- 1. Vorbereitung: Definiere die zu erstellenden Slot-Muster -----

            // Die drei leicht unterschiedlichen KIND-Muster für den Abschnitt "Nord-West"
            const kindPatterns = [
                { von: "X", bis: "S", Abschnitt: "Nord-West", Abfahrt: { stunde: 8, minute: 0 }, Ankunft: { stunde: 8, minute: 45 }, Verkehrsart: "SPFV", Grundentgelt: 120 },
                { von: "X", bis: "S", Abschnitt: "Nord-West", Abfahrt: { stunde: 8, minute: 5 }, Ankunft: { stunde: 8, minute: 50 }, Verkehrsart: "SPFV", Grundentgelt: 120 },
                { von: "X", bis: "S", Abschnitt: "Nord-West", Abfahrt: { stunde: 8, minute: 10 }, Ankunft: { stunde: 8, minute: 55 }, Verkehrsart: "SPFV", Grundentgelt: 120 }
            ];

            const kalenderwochen = [11, 12, 13];
            const verkehrstag = "Mo-Fr";
            const elternSlotTyp = "TAG";

            // Ein Objekt, um die erstellten Slots für den nächsten Schritt leicht zu finden
            const erstellteElternSlots = {};

            // ----- 2. Erstelle alle 9 Slot-Gruppen (3 Muster * 3 KWs) -----

            for (const pattern of kindPatterns) {
                for (const kw of kalenderwochen) {
                    const payload = {
                        elternSlotTyp,
                        Kalenderwoche: kw,
                        Verkehrstag: verkehrstag,
                        Abschnitt: pattern.Abschnitt,
                        alternativen: [pattern]
                    };
                    const response = await request(app).post('/api/slots').send(payload);
                    expect(response.status).toBe(201);

                    const key = `KW${kw}_${pattern.Abfahrt.stunde}${String(pattern.Abfahrt.minute).padStart(2, '0')}`;
                    erstellteElternSlots[key] = response.body.data;
                }
            }
            expect(Object.keys(erstellteElternSlots).length).toBe(9);

            // ----- 3. Erstelle die Anfragen mit der korrekten Eltern-Kind-Struktur -----

            // Finde die spezifischen Slots (Abfahrt 8:00) für die Anfragen in den jeweiligen KWs
            const elternSlot_KW11 = erstellteElternSlots['KW11_800'];
            const elternSlot_KW12 = erstellteElternSlots['KW12_800'];
            const elternSlot_KW13 = erstellteElternSlots['KW13_800'];

            // Bereite die ZugewieseneSlots-Arrays für die verschiedenen Anfragen vor
            const zugewieseneSlots_3Wochen = [
                { slot: elternSlot_KW11._id, kind: elternSlot_KW11.gabelAlternativen[0]._id, statusEinzelzuweisung: 'wartet_konflikt_topf' },
                { slot: elternSlot_KW12._id, kind: elternSlot_KW12.gabelAlternativen[0]._id, statusEinzelzuweisung: 'wartet_konflikt_topf' },
                { slot: elternSlot_KW13._id, kind: elternSlot_KW13.gabelAlternativen[0]._id, statusEinzelzuweisung: 'wartet_konflikt_topf' }
            ];
            const zugewieseneSlots_2Wochen = zugewieseneSlots_3Wochen.slice(0, 2); // Nur KW 11 & 12

            const anfrageBasis = {
                Verkehrsart: "SPFV", Verkehrstag: "Mo-Fr", 
                ListeGewuenschterSlotAbschnitte: [{von:"X", bis:"S", Abfahrtszeit:{stunde:8,minute:0}, Ankunftszeit:{stunde:8,minute:45}}],
                Status: 'validiert'
            };

            // Erstelle die vier Anfragen
            await new Anfrage({ 
                ...anfrageBasis, Zugnummer: "X1", EVU: "Inv1", Email: 'rv@evu1.de',
                Zeitraum: { start: "2025-03-10", ende: "2025-03-30" }, // 3 Wochen
                ZugewieseneSlots: zugewieseneSlots_3Wochen
            }).save();

            await new Anfrage({ 
                ...anfrageBasis, Zugnummer: "Y1", EVU: "Inv1", Email: 'rv@evu1.de', // Selbes EVU wie erste Anfrage
                Zeitraum: { start: "2025-03-10", ende: "2025-03-23" }, // 2 Wochen
                ZugewieseneSlots: zugewieseneSlots_2Wochen 
            }).save();

            await new Anfrage({ 
                ...anfrageBasis, Zugnummer: "Z1", EVU: "Inv1", Email: 'rv@evu1.de', // Selbes EVU wie erste Anfrage
                Zeitraum: { start: "2025-03-10", ende: "2025-03-23" }, // 2 Wochen
                ZugewieseneSlots: zugewieseneSlots_2Wochen
            }).save();

            await new Anfrage({ 
                ...anfrageBasis, Zugnummer: "V1", EVU: "Inv4", Email: 'rv@evu4.de',
                Zeitraum: { start: "2025-03-11", ende: "2025-03-23" }, // Anderer Starttag, aber 2 Wochen
                ZugewieseneSlots: zugewieseneSlots_2Wochen
            }).save();

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

            // ----- 1. Vorbereitung: Definiere die zu erstellenden Slot-Muster -----

            // Gemeinsame Daten für den ELTERN-Teil der Slot-Gruppen
            const elternData = {
                elternSlotTyp: "TAG",
                Verkehrstag: "Sa+So",
            };

            // Gemeinsame Daten für den KIND-Teil der Slot-Gruppen
            const commonKindData = {
                von: "Y", 
                bis: "Z", 
                Abschnitt: "Abschn1",
                Verkehrsart: "SPFV", 
                Grundentgelt: 150
            };

            // Die sechs leicht unterschiedlichen Zeit-Muster, die wir erstellen wollen
            const zeitAlternativen = [
                { Abfahrt: { stunde: 13, minute: 10 }, Ankunft: { stunde: 14, minute: 0 } },
                { Abfahrt: { stunde: 13, minute: 20 }, Ankunft: { stunde: 14, minute: 10 } },
                { Abfahrt: { stunde: 13, minute: 30 }, Ankunft: { stunde: 14, minute: 20 } },
                { Abfahrt: { stunde: 13, minute: 40 }, Ankunft: { stunde: 14, minute: 30 } },
                { Abfahrt: { stunde: 13, minute: 50 }, Ankunft: { stunde: 14, minute: 40 } },
                { Abfahrt: { stunde: 14, minute: 0 }, Ankunft: { stunde: 14, minute: 50 } }
            ];

            const kalenderwochen = [2, 3, 4];
            let topfIdFuerTest;

            // ----- 2. Erstelle alle 18 Slot-Gruppen in verschachtelten Schleifen -----

            for (const kw of kalenderwochen) {
                let topfIdDieserWoche = null;
                for (const zeiten of zeitAlternativen) {
                    // Baue den korrekten, verschachtelten Payload für die API
                    const payload = {
                        ...elternData,
                        Kalenderwoche: kw,
                        Abschnitt: commonKindData.Abschnitt,
                        alternativen: [{
                            ...commonKindData,
                            ...zeiten 
                        }]
                    };

                    const response = await request(app)
                        .post('/api/slots')
                        .send(payload);

                    expect(response.status).toBe(201);

                    // Merke dir die ID des Topfes (ist für alle Slots einer KW dieselbe)
                    if (!topfIdDieserWoche) {
                        topfIdDieserWoche = response.body.data.VerweisAufTopf;
                    }
                }
                // Merke dir die ID des ersten erstellten Topfes für die finale Prüfung
                if (!topfIdFuerTest) {
                    topfIdFuerTest = topfIdDieserWoche;
                }
            }

            // ----- 3. Finale Überprüfung eines repräsentativen Kapazitätstopfes -----
            let kt_DetectConflict = await Kapazitaetstopf.findById(topfIdFuerTest);
            expect(kt_DetectConflict).toBeDefined();
            // Der Topf sollte 6 Eltern-Slots in seiner Liste haben
            expect(kt_DetectConflict.ListeDerSlots).toHaveLength(6); 
            // Die maxKapazitaet sollte korrekt berechnet sein
            expect(kt_DetectConflict.maxKapazitaet).toBe(Math.floor(0.7 * 6)); // = 4

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

            kt_DetectConflict = await Kapazitaetstopf.findById(kt_DetectConflict._id);
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

        it('sollte korrekt Entscheidung Verzicht auf eine Konfliktgruppe mit 3 Slot-Konflikten und 4 beteiligten Anfragen durchfuehren', async () => {
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

        it('sollte korrekt den Entgeltvergleich auf eine Konfliktgruppe mit 3 Slot-Konflikten und 4 beteiligten Anfragen durchfuehren', async () => {
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

            // ----- 1. Vorbereitung: Definiere die zu erstellenden Slot-Muster -----

            // Es gibt 3 Slot-Muster für Abschnitt "Sued" und 3 für Abschnitt "West"
            const slotPatterns = [
                // Abschnitt Sued (3 Muster)
                { elternSlotTyp: "TAG", alternative: { von: "S", bis: "T", Abschnitt: "Sued", Abfahrt: { stunde: 9, minute: 0 }, Ankunft: { stunde: 10, minute: 0 }, Verkehrsart: "SPFV", Grundentgelt: 150 } },
                { elternSlotTyp: "TAG", alternative: { von: "S", bis: "T", Abschnitt: "Sued", Abfahrt: { stunde: 9, minute: 10 }, Ankunft: { stunde: 10, minute: 10 }, Verkehrsart: "SPFV", Grundentgelt: 150 } },
                { elternSlotTyp: "TAG", alternative: { von: "S", bis: "T", Abschnitt: "Sued", Abfahrt: { stunde: 9, minute: 20 }, Ankunft: { stunde: 10, minute: 20 }, Verkehrsart: "SPFV", Grundentgelt: 150 } },
                // Abschnitt West (3 Muster)
                { elternSlotTyp: "TAG", alternative: { von: "X", bis: "S", Abschnitt: "West", Abfahrt: { stunde: 8, minute: 0 }, Ankunft: { stunde: 8, minute: 45 }, Verkehrsart: "SPFV", Grundentgelt: 120 } },
                { elternSlotTyp: "TAG", alternative: { von: "X", bis: "S", Abschnitt: "West", Abfahrt: { stunde: 8, minute: 5 }, Ankunft: { stunde: 8, minute: 50 }, Verkehrsart: "SPFV", Grundentgelt: 120 } },
                { elternSlotTyp: "TAG", alternative: { von: "X", bis: "S", Abschnitt: "West", Abfahrt: { stunde: 8, minute: 10 }, Ankunft: { stunde: 8, minute: 55 }, Verkehrsart: "SPFV", Grundentgelt: 120 } }
            ];

            const kalenderwochen = [11, 12, 13, 14];
            const verkehrstag = "Mo-Fr";

            // Ein Objekt, um die erstellten Slots für den nächsten Schritt leicht zu finden
            const erstellteElternSlots = {};

            // ----- 2. Erstelle alle 24 Slot-Gruppen (6 Muster * 4 KWs) -----

            for (const pattern of slotPatterns) {
                for (const kw of kalenderwochen) {
                    const payload = {
                        elternSlotTyp: pattern.elternSlotTyp,
                        Kalenderwoche: kw,
                        Verkehrstag: verkehrstag,
                        Abschnitt: pattern.alternative.Abschnitt,
                        alternativen: [pattern.alternative]
                    };
                    const response = await request(app).post('/api/slots').send(payload);
                    expect(response.status).toBe(201);

                    const key = `${pattern.alternative.Abschnitt}_KW${kw}_${pattern.alternative.Abfahrt.stunde}${String(pattern.alternative.Abfahrt.minute).padStart(2, '0')}`;
                    erstellteElternSlots[key] = response.body.data;
                }
            }
            expect(Object.keys(erstellteElternSlots).length).toBe(24); // 6 Muster * 4 KWs

            // ----- 3. Erstelle die Anfragen mit der korrekten Eltern-Kind-Struktur -----

            // Finde die spezifischen Slots (X->S um 8:00 und S->T um 9:00) für alle KWs
            const zugewieseneSlotsFuerAnfrage = [];
            for (const kw of kalenderwochen) {
                const elternSlot_West = erstellteElternSlots[`West_KW${kw}_800`];
                const elternSlot_Sued = erstellteElternSlots[`Sued_KW${kw}_900`];
                
                zugewieseneSlotsFuerAnfrage.push(
                    { slot: elternSlot_West._id, kind: elternSlot_West.gabelAlternativen[0]._id, statusEinzelzuweisung: 'wartet_konflikt_topf' },
                    { slot: elternSlot_Sued._id, kind: elternSlot_Sued.gabelAlternativen[0]._id, statusEinzelzuweisung: 'wartet_konflikt_topf' }
                );
            }

            const anfrageBasis = {
                Verkehrsart: "SPFV", Verkehrstag: "Mo-Fr", 
                Zeitraum: { start: "2025-03-10", ende: "2025-04-06" }, // KW 11-14
                ListeGewuenschterSlotAbschnitte: [
                    {von:"X", bis:"S", Abfahrtszeit:{stunde:8,minute:0}, Ankunftszeit:{stunde:8,minute:45}},
                    {von:"S", bis:"T", Abfahrtszeit:{stunde:9,minute:0}, Ankunftszeit:{stunde:10,minute:0}}
                ], 
                Email: 'rv@evu.de',
                Status: 'validiert',
                ZugewieseneSlots: zugewieseneSlotsFuerAnfrage // Alle 8 Slots (2 pro KW * 4 KWs)
            };

            // Erstelle die beiden Anfragen
            await new Anfrage({ ...anfrageBasis, Zugnummer: "X1", EVU: "Inv3" }).save();
            await new Anfrage({ ...anfrageBasis, Zugnummer: "Y1", EVU: "Inv4" }).save();

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
            const gruppenschluessel0 = `#${slotPatterns[0].alternative.von}#${slotPatterns[0].alternative.bis}#${formatTimeForID(slotPatterns[0].alternative.Abfahrt.stunde, slotPatterns[0].alternative.Abfahrt.minute)}#${slotPatterns[0].alternative.Verkehrsart}|${anfrage_X._id}#${anfrage_Y._id}`;
            const gruppenschluessel1 = `#${slotPatterns[3].alternative.von}#${slotPatterns[3].alternative.bis}#${formatTimeForID(slotPatterns[3].alternative.Abfahrt.stunde, slotPatterns[3].alternative.Abfahrt.minute)}#${slotPatterns[3].alternative.Verkehrsart}|${anfrage_X._id}#${anfrage_Y._id}`;
            expect(gruppen[0].gruppenSchluessel).toBe(gruppenschluessel0);
            expect(gruppen[1].gruppenSchluessel).toBe(gruppenschluessel1);
            //console.log(gruppen[0]);
        });

        it('sollte den Status der Gruppe und der Anfragen auch bei mehrmaliger Konfliktanalyse der Slot-Konflikte korrekt beibehalten', async () => {
            // ---- SETUP: Erzeuge einen Konflikt mit 4 Kapazitäten und 4 Anfragen auf dem selben Slot, die bis zum Höchstpreis kommen ----

            
            // ----- 1. Vorbereitung: Definiere die zu erstellenden Slot-Muster -----

            // Die sechs leicht unterschiedlichen KIND-Muster für den Abschnitt "West"
            const kindPatterns = [
                { von: "X", bis: "S", Abschnitt: "West", Abfahrt: { stunde: 8, minute: 0 }, Ankunft: { stunde: 8, minute: 45 }, Verkehrsart: "SPFV", Grundentgelt: 120 },
                { von: "X", bis: "S", Abschnitt: "West", Abfahrt: { stunde: 8, minute: 5 }, Ankunft: { stunde: 8, minute: 50 }, Verkehrsart: "SPFV", Grundentgelt: 120 },
                { von: "X", bis: "S", Abschnitt: "West", Abfahrt: { stunde: 8, minute: 10 }, Ankunft: { stunde: 8, minute: 55 }, Verkehrsart: "SPFV", Grundentgelt: 120 },
                { von: "X", bis: "S", Abschnitt: "West", Abfahrt: { stunde: 8, minute: 15 }, Ankunft: { stunde: 9, minute: 0 }, Verkehrsart: "SPFV", Grundentgelt: 120 },
                { von: "X", bis: "S", Abschnitt: "West", Abfahrt: { stunde: 8, minute: 20 }, Ankunft: { stunde: 9, minute: 5 }, Verkehrsart: "SPFV", Grundentgelt: 120 },
                { von: "X", bis: "S", Abschnitt: "West", Abfahrt: { stunde: 8, minute: 25 }, Ankunft: { stunde: 9, minute: 10 }, Verkehrsart: "SPFV", Grundentgelt: 120 }
            ];

            const kalenderwochen = [11, 12, 13];
            const verkehrstag = "Mo-Fr";
            const elternSlotTyp = "TAG";

            // Ein Objekt, um die erstellten Slots für den nächsten Schritt leicht zu finden
            const erstellteElternSlots = {};

            // ----- 2. Erstelle alle 18 Slot-Gruppen (6 Muster * 3 KWs) -----

            for (const pattern of kindPatterns) {
                for (const kw of kalenderwochen) {
                    const payload = {
                        elternSlotTyp,
                        Kalenderwoche: kw,
                        Verkehrstag: verkehrstag,
                        Abschnitt: pattern.Abschnitt,
                        alternativen: [pattern]
                    };
                    const response = await request(app).post('/api/slots').send(payload);
                    expect(response.status).toBe(201);

                    const key = `KW${kw}_${pattern.Abfahrt.stunde}${String(pattern.Abfahrt.minute).padStart(2, '0')}`;
                    erstellteElternSlots[key] = response.body.data;
                }
            }
            expect(Object.keys(erstellteElternSlots).length).toBe(18); // 6 Muster * 3 KWs

            // ----- 3. Erstelle die Anfragen mit der korrekten Eltern-Kind-Struktur -----

            // Finde die spezifischen Slots (Abfahrt 8:00) für die Anfragen in den jeweiligen KWs
            const elternSlot_KW11 = erstellteElternSlots['KW11_800'];
            const elternSlot_KW12 = erstellteElternSlots['KW12_800'];
            const elternSlot_KW13 = erstellteElternSlots['KW13_800'];

            // Bereite die ZugewieseneSlots-Arrays für die verschiedenen Anfragen vor
            const zugewieseneSlots_3Wochen = [
                { slot: elternSlot_KW11._id, kind: elternSlot_KW11.gabelAlternativen[0]._id, statusEinzelzuweisung: 'wartet_konflikt_topf' },
                { slot: elternSlot_KW12._id, kind: elternSlot_KW12.gabelAlternativen[0]._id, statusEinzelzuweisung: 'wartet_konflikt_topf' },
                { slot: elternSlot_KW13._id, kind: elternSlot_KW13.gabelAlternativen[0]._id, statusEinzelzuweisung: 'wartet_konflikt_topf' }
            ];
            const zugewieseneSlots_2Wochen = zugewieseneSlots_3Wochen.slice(0, 2); // Nur KW 11 & 12

            const anfrageBasis = {
                Verkehrsart: "SPFV", Verkehrstag: "Mo-Fr", 
                ListeGewuenschterSlotAbschnitte: [{von:"X", bis:"S", Abfahrtszeit:{stunde:8,minute:0}, Ankunftszeit:{stunde:8,minute:45}}],
                Status: 'validiert'
            };

            // Erstelle die vier Anfragen
            await new Anfrage({ 
                ...anfrageBasis, Zugnummer: "X1", EVU: "Inv1", Email: 'rv@evu1.de',
                Zeitraum: { start: "2025-03-10", ende: "2025-03-30" }, // 3 Wochen
                ZugewieseneSlots: zugewieseneSlots_3Wochen
            }).save();

            await new Anfrage({ 
                ...anfrageBasis, Zugnummer: "Y1", EVU: "Inv2", Email: 'rv@evu2.de',
                Zeitraum: { start: "2025-03-10", ende: "2025-03-23" }, // 2 Wochen
                ZugewieseneSlots: zugewieseneSlots_2Wochen 
            }).save();

            await new Anfrage({ 
                ...anfrageBasis, Zugnummer: "Z1", EVU: "Inv3", Email: 'rv@evu3.de',
                Zeitraum: { start: "2025-03-10", ende: "2025-03-23" }, // 2 Wochen
                ZugewieseneSlots: zugewieseneSlots_2Wochen
            }).save();

            await new Anfrage({ 
                ...anfrageBasis, Zugnummer: "V1", EVU: "Inv4", Email: 'rv@evu4.de',
                Zeitraum: { start: "2025-03-11", ende: "2025-03-23" }, // Anderer Starttag, aber 2 Wochen
                ZugewieseneSlots: zugewieseneSlots_2Wochen
            }).save();

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


            // ----- 1. Vorbereitung: Definiere die zu erstellenden Slot-Muster -----

            const zeitraum = { 
                start: '2025-07-07', 
                ende: '2025-08-03'
            };
            const gemeinsamerVerkehrstag = 'täglich';

            // Wir definieren eine Liste aller 13 einzigartigen Slot-Muster, die wir erstellen wollen.
            const slotPatternsToCreate = [
                // 3 Nacht-Slots auf C-D
                { elternSlotTyp: "NACHT", alternative: { von: "C", bis: "D", Abschnitt: "Strecke3", Grundentgelt: 100, Zeitfenster: '03-05', Mindestfahrzeit: 60, Maximalfahrzeit: 90, Verkehrsart: 'ALLE' } },
                { elternSlotTyp: "NACHT", alternative: { von: "C", bis: "D", Abschnitt: "Strecke3", Grundentgelt: 100, Zeitfenster: '03-05', Mindestfahrzeit: 60, Maximalfahrzeit: 90, Verkehrsart: 'ALLE' } },
                { elternSlotTyp: "NACHT", alternative: { von: "C", bis: "D", Abschnitt: "Strecke3", Grundentgelt: 100, Zeitfenster: '03-05', Mindestfahrzeit: 60, Maximalfahrzeit: 90, Verkehrsart: 'ALLE' } },
                
                // 5 Tages-Slots auf D-E
                { elternSlotTyp: "TAG", alternative: { von: "D", bis: "E", Abschnitt: "Strecke4", Verkehrsart: "SGV", Grundentgelt: 100, Abfahrt: { stunde: 5, minute: 3 }, Ankunft: { stunde: 6, minute: 49 } } },
                { elternSlotTyp: "TAG", alternative: { von: "D", bis: "E", Abschnitt: "Strecke4", Verkehrsart: "SGV", Grundentgelt: 100, Abfahrt: { stunde: 5, minute: 13 }, Ankunft: { stunde: 6, minute: 59 } } },
                { elternSlotTyp: "TAG", alternative: { von: "D", bis: "E", Abschnitt: "Strecke4", Verkehrsart: "SGV", Grundentgelt: 100, Abfahrt: { stunde: 5, minute: 23 }, Ankunft: { stunde: 7, minute: 9 } } },
                { elternSlotTyp: "TAG", alternative: { von: "D", bis: "E", Abschnitt: "Strecke4", Verkehrsart: "SGV", Grundentgelt: 100, Abfahrt: { stunde: 5, minute: 33 }, Ankunft: { stunde: 7, minute: 19 } } },
                { elternSlotTyp: "TAG", alternative: { von: "D", bis: "E", Abschnitt: "Strecke4", Verkehrsart: "SGV", Grundentgelt: 100, Abfahrt: { stunde: 5, minute: 43 }, Ankunft: { stunde: 7, minute: 29 } } },

                // 5 Tages-Slots auf D-F
                { elternSlotTyp: "TAG", alternative: { von: "D", bis: "F", Abschnitt: "Strecke5", Verkehrsart: "SGV", Grundentgelt: 100, Abfahrt: { stunde: 5, minute: 7 }, Ankunft: { stunde: 6, minute: 49 } } },
                { elternSlotTyp: "TAG", alternative: { von: "D", bis: "F", Abschnitt: "Strecke5", Verkehrsart: "SGV", Grundentgelt: 100, Abfahrt: { stunde: 5, minute: 17 }, Ankunft: { stunde: 6, minute: 59 } } },
                { elternSlotTyp: "TAG", alternative: { von: "D", bis: "F", Abschnitt: "Strecke5", Verkehrsart: "SGV", Grundentgelt: 100, Abfahrt: { stunde: 5, minute: 27 }, Ankunft: { stunde: 7, minute: 9 } } },
                { elternSlotTyp: "TAG", alternative: { von: "D", bis: "F", Abschnitt: "Strecke5", Verkehrsart: "SGV", Grundentgelt: 100, Abfahrt: { stunde: 5, minute: 37 }, Ankunft: { stunde: 7, minute: 19 } } },
                { elternSlotTyp: "TAG", alternative: { von: "D", bis: "F", Abschnitt: "Strecke5", Verkehrsart: "SGV", Grundentgelt: 100, Abfahrt: { stunde: 5, minute: 47 }, Ankunft: { stunde: 7, minute: 29 } } },
            ];

            const erstellteElternSlots = [];

            // ----- 2. Erstelle alle Slot-Gruppen-Serien in einer Schleife -----

            for (const pattern of slotPatternsToCreate) {
                // Baue den Payload für den Massen-Erstellungs-Endpunkt
                const payload = {
                    elternSlotTyp: pattern.elternSlotTyp,
                    Verkehrstag: gemeinsamerVerkehrstag,
                    zeitraumStart: zeitraum.start,
                    zeitraumEnde: zeitraum.ende,
                    Abschnitt: pattern.alternative.Abschnitt,
                    alternativen: [
                        pattern.alternative
                    ]
                };

                // Sende den Payload an den API-Endpunkt
                const response = await request(app)
                    .post('/api/slots/massen-erstellung')
                    .send(payload);

                expect(response.status).toBe(201);
                expect(response.body.erstellteSlots).toBeDefined();
                // Jeder Aufruf erzeugt Slots für 4 Wochen * 2 Verkehrstage = 8 Slot-Gruppen
                // (Annahme: Zeitraum sind 4 Wochen, z.B. KW 28, 29, 30, 31)
                expect(response.body.erstellteSlots).toHaveLength(8); 
                erstellteElternSlots.push(...response.body.erstellteSlots);
            }

            // ----- 3. Finale Überprüfung -----
            const kt_all = await Kapazitaetstopf.find({});
            // 4 Wochen * 2 VTs = 8 Kombinationen pro Topf-Muster.
            // Topf-Muster 1: Strecke3, ALLE, 03-05 -> 8 Töpfe
            // Topf-Muster 2: Strecke4, SGV, 05-07 -> 8 Töpfe
            // Topf-Muster 3: Strecke5, SGV, 05-07 -> 8 Töpfe
            // Da Muster 2 und 3 im selben Zeitfenster liegen (05-07), aber unterschiedliche Abschnitte haben,
            // ergeben sie unterschiedliche Töpfe. Total = 8 + 8 + 8 = 24 Töpfe.
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

            // ----- 1. Vorbereitung: Definiere die zu erstellenden Slot-Muster -----

            const zeitraum = { 
                start: '2025-07-07', 
                ende: '2025-08-03'
            };
            const gemeinsamerVerkehrstag = 'täglich';

            // Wir definieren eine Liste aller 8 einzigartigen Slot-Muster, die wir als Serie erstellen wollen.
            const slotPatternsToCreate = [
                // 3 identische Nacht-Slots auf C-D (erzeugen 3 Eltern-Slots im selben Topf-Muster)
                { elternSlotTyp: "NACHT", alternative: { von: "C", bis: "D", Abschnitt: "Strecke3", Grundentgelt: 100, Zeitfenster: '03-05', Mindestfahrzeit: 60, Maximalfahrzeit: 90, Verkehrsart: 'ALLE' } },
                { elternSlotTyp: "NACHT", alternative: { von: "C", bis: "D", Abschnitt: "Strecke3", Grundentgelt: 100, Zeitfenster: '03-05', Mindestfahrzeit: 60, Maximalfahrzeit: 90, Verkehrsart: 'ALLE' } },
                { elternSlotTyp: "NACHT", alternative: { von: "C", bis: "D", Abschnitt: "Strecke3", Grundentgelt: 100, Zeitfenster: '03-05', Mindestfahrzeit: 60, Maximalfahrzeit: 90, Verkehrsart: 'ALLE' } },
                
                // 5 unterschiedliche Tages-Slots auf D-E
                { elternSlotTyp: "TAG", alternative: { von: "D", bis: "E", Abschnitt: "Strecke4", Verkehrsart: "SGV", Grundentgelt: 100, Abfahrt: { stunde: 5, minute: 3 }, Ankunft: { stunde: 6, minute: 49 } } },
                { elternSlotTyp: "TAG", alternative: { von: "D", bis: "E", Abschnitt: "Strecke4", Verkehrsart: "SGV", Grundentgelt: 100, Abfahrt: { stunde: 5, minute: 13 }, Ankunft: { stunde: 6, minute: 59 } } },
                { elternSlotTyp: "TAG", alternative: { von: "D", bis: "E", Abschnitt: "Strecke4", Verkehrsart: "SGV", Grundentgelt: 100, Abfahrt: { stunde: 5, minute: 23 }, Ankunft: { stunde: 7, minute: 9 } } },
                { elternSlotTyp: "TAG", alternative: { von: "D", bis: "E", Abschnitt: "Strecke4", Verkehrsart: "SGV", Grundentgelt: 100, Abfahrt: { stunde: 5, minute: 33 }, Ankunft: { stunde: 7, minute: 19 } } },
                { elternSlotTyp: "TAG", alternative: { von: "D", bis: "E", Abschnitt: "Strecke4", Verkehrsart: "SGV", Grundentgelt: 100, Abfahrt: { stunde: 5, minute: 43 }, Ankunft: { stunde: 7, minute: 29 } } },
                ];

            let response;

            // ----- 2. Erstelle alle Slot-Gruppen-Serien in einer Schleife -----

            for (const pattern of slotPatternsToCreate) {
                // Baue den Payload für den Massen-Erstellungs-Endpunkt
                const payload = {
                    elternSlotTyp: pattern.elternSlotTyp,
                    Verkehrstag: gemeinsamerVerkehrstag,
                    zeitraumStart: zeitraum.start,
                    zeitraumEnde: zeitraum.ende,
                    Abschnitt: pattern.alternative.Abschnitt,
                    alternativen: [
                        pattern.alternative
                    ]
                };

                // Sende den Payload an den API-Endpunkt
                response = await request(app)
                    .post('/api/slots/massen-erstellung')
                    .send(payload);

                expect(response.status).toBe(201);
                expect(response.body.erstellteSlots).toBeDefined();
            }

            // ----- 3. Finale Überprüfung -----
            const kt_all = await Kapazitaetstopf.find({});
            // 4 Wochen * 2 VTs = 8 Kombinationen pro Topf-Muster.
            // Topf-Muster 1: Strecke3, ALLE, 03-05 -> 8 Töpfe
            // Topf-Muster 2: Strecke4, SGV, 05-07 -> 8 Töpfe
            // Total = 24 Töpfe
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
