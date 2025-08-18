// tests/integration/anfrageZuordnung.test.js
const request = require('supertest');
const mongoose = require('mongoose');
const app = require('../../server');
const {Slot} = require('../../models/Slot');
const Kapazitaetstopf = require('../../models/Kapazitaetstopf');
const Anfrage = require('../../models/Anfrage');
const { UTCDate } = require('@date-fns/utc');
const { addDays, differenceInCalendarWeeks, parseISO, eachDayOfInterval, getDay, isWithinInterval, startOfWeek, endOfWeek, startOfDay, endOfDay } = require('date-fns');



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
const GLOBAL_KW1_START_DATE_ISO = "2024-12-30T00:00:00.000Z";


function calculateTotalOperatingDaysForAnfrage(anfrageZeitraum, anfrageVerkehrstagGruppe) {
    if (!anfrageZeitraum || !anfrageZeitraum.start || !anfrageZeitraum.ende || !anfrageVerkehrstagGruppe) {
        console.warn("calculateTotalOperatingDaysForAnfrage: Ungültige Eingabedaten.");
        return 0;
    }
    try {
        //const start = startOfDay(parseISO(anfrageZeitraum.start.toISOString ? anfrageZeitraum.start.toISOString() : anfrageZeitraum.start));
        const start = new UTCDate(anfrageZeitraum.start);
        const ende = new UTCDate(anfrageZeitraum.ende);
        //const ende = endOfDay(parseISO(anfrageZeitraum.ende.toISOString ? anfrageZeitraum.ende.toISOString() : anfrageZeitraum.ende));

        if (start > ende) {
            console.warn(`calculateTotalOperatingDaysForAnfrage: Zeitraum start > ende, Zeitraum ${anfrageZeitraum}, start ${start}, ende ${ende}`);
            return 0;
        }

        const tageImIntervall = eachDayOfInterval ({ start: start, end: ende });
        //console.log(tageImIntervall);
        let betriebstage = 0;

        for (const tag of tageImIntervall) {
            const wochentagNummer = getDay(tag); // Sonntag=0, Montag=1, ..., Samstag=6

            if (anfrageVerkehrstagGruppe === 'täglich') {
                betriebstage++;
            } else if (anfrageVerkehrstagGruppe === 'Mo-Fr' && wochentagNummer >= 1 && wochentagNummer <= 5) {
                betriebstage++;
            } else if (anfrageVerkehrstagGruppe === 'Sa+So' && (wochentagNummer === 0 || wochentagNummer === 6)) {
                betriebstage++;
            }
        }

        if(betriebstage === 0){
            console.warn(`calculateTotalOperatingDaysForAnfrage: 0 Betriebstage, Zeitraum ${anfrageZeitraum}, start ${start}, ende ${ende}, Verkehrstage ${anfrageVerkehrstagGruppe}`);
            return 0;
        }
        return betriebstage;
    } catch (e) {
        console.error("Fehler in calculateTotalOperatingDaysForAnfrage:", e);
        return 0;
    }
}

describe('Anfrage Zuordnung zu Kapazitätstöpfen (/api/anfragen/:id/zuordnen)', () => {
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

    // Testfall C (vorherige Version, kann bleiben oder durch C_Erweitert ersetzt/ergänzt werden)
    it('Szenario C (ursprünglich): Tägliche Anfrage (1 Abschnitt) über 2 KWs auf 4 Töpfe', async () => {
        // ----- 1. Vorbereitung: Slots erstellen (Töpfe werden auto-erstellt) -----
        const commonSlotParams = {
            slotTyp: 'TAG',
            von: "StadtA", bis: "StadtB", Abschnitt: "Hauptkorridor",
            Abfahrt: { stunde: 8, minute: 0 }, Ankunft: { stunde: 9, minute: 0 },
            Verkehrsart: "SPFV", Grundentgelt: 150
        };

        // Slots für KW1 (global relativ)
        const slotMoFrKW1Data = { ...commonSlotParams, Kalenderwoche: 1, Verkehrstag: "Mo-Fr" };
        const slotSaSoKW1Data = { ...commonSlotParams, Kalenderwoche: 1, Verkehrstag: "Sa+So" };
        // Slots für KW2 (global relativ)
        const slotMoFrKW2Data = { ...commonSlotParams, Kalenderwoche: 2, Verkehrstag: "Mo-Fr" };
        const slotSaSoKW2Data = { ...commonSlotParams, Kalenderwoche: 2, Verkehrstag: "Sa+So" };

        const respSlot1 = await request(app).post('/api/slots').send(slotMoFrKW1Data);
        const respSlot2 = await request(app).post('/api/slots').send(slotSaSoKW1Data);
        const respSlot3 = await request(app).post('/api/slots').send(slotMoFrKW2Data);
        const respSlot4 = await request(app).post('/api/slots').send(slotSaSoKW2Data);

        expect(respSlot1.status).toBe(201); 
        expect(respSlot2.status).toBe(201);
        expect(respSlot3.status).toBe(201); 
        expect(respSlot4.status).toBe(201);

        const slotMoFrKW1 = respSlot1.body.data;
        const slotSaSoKW1 = respSlot2.body.data;
        const slotMoFrKW2 = respSlot3.body.data;
        const slotSaSoKW2 = respSlot4.body.data;

        // IDs der automatisch erstellten/gefundenen Kapazitätstöpfe holen
        const ktMoFrKW1_Id = slotMoFrKW1.VerweisAufTopf;
        const ktSaSoKW1_Id = slotSaSoKW1.VerweisAufTopf;
        const ktMoFrKW2_Id = slotMoFrKW2.VerweisAufTopf;
        const ktSaSoKW2_Id = slotSaSoKW2.VerweisAufTopf;

        expect(ktMoFrKW1_Id).toBeDefined(); 
        expect(ktSaSoKW1_Id).toBeDefined();
        expect(ktMoFrKW2_Id).toBeDefined(); 
        expect(ktSaSoKW2_Id).toBeDefined();
        // Sicherstellen, dass es vier unterschiedliche Töpfe sind (aufgrund KW und Verkehrstag)
        const topfIds = new Set([ktMoFrKW1_Id, ktSaSoKW1_Id, ktMoFrKW2_Id, ktSaSoKW2_Id]);
        expect(topfIds.size).toBe(4);


        // ----- 2. Anfrage erstellen -----
        const anfrageData = {
            Zugnummer: "100", EVU: "DB Fernverkehr AG",
            ListeGewuenschterSlotAbschnitte: [{
                von: "StadtA", bis: "StadtB",
                Abfahrtszeit: { stunde: 8, minute: 0 }, Ankunftszeit: { stunde: 9, minute: 0 }
            }],
            Verkehrsart: "SPFV",
            Verkehrstag: "täglich",
            Zeitraum: {
                start: "2024-12-30", // Mo, 30.12.2024 (Start KW1)
                ende: "2025-01-12" // So, 12.01.2025 (Ende KW2)
            },
            Email: "test@example.com",
            Status: "validiert", // Wir erstellen sie direkt als 'validiert' für diesen Test
            //ZugewieseneSlots: [slotMoFrKW1._id, slotSaSoKW1._id, slotMoFrKW2._id, slotSaSoKW2._id], //hier muss noch alle Slot-IDs in das Feld ZugewieseneSlots hinterlegt werden
            //Entgelt: 2100
        };
        // Man wird eine Anfrage mit POST /api/anfragen erstellt
        // und dann den Status auf 'validiert' setzen, falls die Erstellung nicht direkt 'validiert' erlaubt.
        // Hier nehmen wir an, sie kann als 'validiert' erstellt werden oder wir setzen den Status manuell in der DB.
        const anfrageErstelltResponse = await request(app).post('/api/anfragen').send(anfrageData);
        expect(anfrageErstelltResponse.status).toBe(201); // Annahme: POST /api/anfragen gibt 201 bei Erfolg
        let anfrageErstellt = anfrageErstelltResponse.body.data;
        anfrageErstellt = await Anfrage.findById(anfrageErstellt._id);
        //console.log(anfrageErstellt);
        anfrageErstellt.Status = 'validiert';
        await anfrageErstellt.save();
        expect(anfrageErstellt.Status).toBe("validiert");


        // ----- 3. Aktion: Zuordnungsprozess anstoßen -----
        const zuordnenResponse = await request(app)
            .post(`/api/anfragen/${anfrageErstellt._id}/zuordnen`)
            .send();

        //console.log(zuordnenResponse);
        expect(zuordnenResponse.status).toBe(200);
        const aktualisierteAnfrage = zuordnenResponse.body.data;
        expect(aktualisierteAnfrage.Status).toBe("in_konfliktpruefung");

        // ----- 4. Überprüfung -----
        // 4.1 Zugewiesene Slots in der Anfrage
        expect(aktualisierteAnfrage.ZugewieseneSlots).toHaveLength(4);
        const zugewieseneSlotIdsInAnfrage = aktualisierteAnfrage.ZugewieseneSlots.map(obj => obj.slot.toString());
        expect(zugewieseneSlotIdsInAnfrage).toContain(slotMoFrKW1._id.toString());
        expect(zugewieseneSlotIdsInAnfrage).toContain(slotSaSoKW1._id.toString());
        expect(zugewieseneSlotIdsInAnfrage).toContain(slotMoFrKW2._id.toString());
        expect(zugewieseneSlotIdsInAnfrage).toContain(slotSaSoKW2._id.toString());
        const zugewieseneSlotStatusInAnfrage = aktualisierteAnfrage.ZugewieseneSlots.map(obj => obj.statusEinzelzuweisung);
        expect(new Set(zugewieseneSlotStatusInAnfrage).size).toBe(1);
        expect(zugewieseneSlotStatusInAnfrage[0]).toBe('initial_in_konfliktpruefung_topf');
        //expect([1,1,1,1].every( (val, i, zugewieseneSlotStatusInAnfrage) => val === zugewieseneSlotStatusInAnfrage[0] )).toBe(true);

        // 4.2 Kapazitätstopf-Listen
        const ktMoFrKW1_final = await Kapazitaetstopf.findById(ktMoFrKW1_Id);
        const ktSaSoKW1_final = await Kapazitaetstopf.findById(ktSaSoKW1_Id);
        const ktMoFrKW2_final = await Kapazitaetstopf.findById(ktMoFrKW2_Id);
        const ktSaSoKW2_final = await Kapazitaetstopf.findById(ktSaSoKW2_Id);

        expect(ktMoFrKW1_final.ListeDerAnfragen.map(id => id.toString())).toContain(anfrageErstellt._id.toString());
        expect(ktSaSoKW1_final.ListeDerAnfragen.map(id => id.toString())).toContain(anfrageErstellt._id.toString());
        expect(ktMoFrKW2_final.ListeDerAnfragen.map(id => id.toString())).toContain(anfrageErstellt._id.toString());
        expect(ktSaSoKW2_final.ListeDerAnfragen.map(id => id.toString())).toContain(anfrageErstellt._id.toString());

        // 4.3 Slots zugewiesene Anfragen
        const slot1_final = await Slot.findById(slotMoFrKW1._id);
        const slot2_final = await Slot.findById(slotSaSoKW1._id);
        const slot3_final = await Slot.findById(slotMoFrKW2._id);
        const slot4_final = await Slot.findById(slotSaSoKW2._id);

        expect(slot1_final.zugewieseneAnfragen.map(id => id.toString())).toContain(anfrageErstellt._id.toString());
        expect(slot2_final.zugewieseneAnfragen.map(id => id.toString())).toContain(anfrageErstellt._id.toString());
        expect(slot3_final.zugewieseneAnfragen.map(id => id.toString())).toContain(anfrageErstellt._id.toString());
        expect(slot4_final.zugewieseneAnfragen.map(id => id.toString())).toContain(anfrageErstellt._id.toString());

        // WICHTIG: Teste auch das berechnete Entgelt
        // Annahme: Alle 4 genutzten Slot-Muster haben Grundentgelt 150.
        // Die Anfrage läuft über 2 volle KWs "täglich", also 14 Tage.
        // Jeder Abschnitt der Anfrage wird an diesen 14 Tagen befahren.
        // Pro Tag kostet ein Abschnitt 150€. Summe pro Durchlauf = 150€ (für den einen Abschnitt).
        // Gesamtentgelt = 14 Tage * 150€/Tag = 2100€.
        const erwartetesEntgelt = 14 * (150); // 14 Tage * (Grundentgelt SlotTyp)
        expect(aktualisierteAnfrage.Entgelt).toBe(erwartetesEntgelt);
    });

    // NEUER ERWEITERTER TESTFALL
    it('Szenario C_Erweitert: Tägliche Anfrage (2 Abschnitte) über 2 KWs soll auf 8 Kapazitätstöpfe gemappt werden', async () => {
        // ----- 1. Vorbereitung: Slots erstellen (Töpfe werden auto-erstellt) -----
        const abschnitt1 = "Strecke_AB";
        const abschnitt2 = "Strecke_BC"; // Unterschiedlicher Abschnitt für den zweiten Teil der Reise
        const gemeinsameVerkehrsart = "SPFV";
        const gemeinsameAbfahrtStunde = 8; // Führt zu Zeitfenster "07-09"
        const gemeinsameAnkunftStunde = 9;

        const slotDefinitions = [];
        // Slots für Abschnitt 1 (Strecke_AB)
        slotDefinitions.push({ slotTyp: 'TAG', von: "A", bis: "B", Abschnitt: abschnitt1, Kalenderwoche: 1, Verkehrstag: "Mo-Fr", Verkehrsart: gemeinsameVerkehrsart, Abfahrt: { stunde: gemeinsameAbfahrtStunde, minute: 0 }, Ankunft: { stunde: gemeinsameAnkunftStunde, minute: 0 }, Grundentgelt: 150 });
        slotDefinitions.push({ slotTyp: 'TAG', von: "A", bis: "B", Abschnitt: abschnitt1, Kalenderwoche: 1, Verkehrstag: "Sa+So", Verkehrsart: gemeinsameVerkehrsart, Abfahrt: { stunde: gemeinsameAbfahrtStunde, minute: 0 }, Ankunft: { stunde: gemeinsameAnkunftStunde, minute: 0 }, Grundentgelt: 150 });
        slotDefinitions.push({ slotTyp: 'TAG', von: "A", bis: "B", Abschnitt: abschnitt1, Kalenderwoche: 2, Verkehrstag: "Mo-Fr", Verkehrsart: gemeinsameVerkehrsart, Abfahrt: { stunde: gemeinsameAbfahrtStunde, minute: 0 }, Ankunft: { stunde: gemeinsameAnkunftStunde, minute: 0 }, Grundentgelt: 150 });
        slotDefinitions.push({ slotTyp: 'TAG', von: "A", bis: "B", Abschnitt: abschnitt1, Kalenderwoche: 2, Verkehrstag: "Sa+So", Verkehrsart: gemeinsameVerkehrsart, Abfahrt: { stunde: gemeinsameAbfahrtStunde, minute: 0 }, Ankunft: { stunde: gemeinsameAnkunftStunde, minute: 0 }, Grundentgelt: 150 });
        // Slots für Abschnitt 2 (Strecke_BC)
        slotDefinitions.push({ slotTyp: 'TAG', von: "B", bis: "C", Abschnitt: abschnitt2, Kalenderwoche: 1, Verkehrstag: "Mo-Fr", Verkehrsart: gemeinsameVerkehrsart, Abfahrt: { stunde: gemeinsameAbfahrtStunde, minute: 0 }, Ankunft: { stunde: gemeinsameAnkunftStunde, minute: 0 }, Grundentgelt: 150 }); // Gleiche Zeiten für Einfachheit, könnten auch andere sein
        slotDefinitions.push({ slotTyp: 'TAG', von: "B", bis: "C", Abschnitt: abschnitt2, Kalenderwoche: 1, Verkehrstag: "Sa+So", Verkehrsart: gemeinsameVerkehrsart, Abfahrt: { stunde: gemeinsameAbfahrtStunde, minute: 0 }, Ankunft: { stunde: gemeinsameAnkunftStunde, minute: 0 }, Grundentgelt: 150 });
        slotDefinitions.push({ slotTyp: 'TAG', von: "B", bis: "C", Abschnitt: abschnitt2, Kalenderwoche: 2, Verkehrstag: "Mo-Fr", Verkehrsart: gemeinsameVerkehrsart, Abfahrt: { stunde: gemeinsameAbfahrtStunde, minute: 0 }, Ankunft: { stunde: gemeinsameAnkunftStunde, minute: 0 }, Grundentgelt: 150 });
        slotDefinitions.push({ slotTyp: 'TAG', von: "B", bis: "C", Abschnitt: abschnitt2, Kalenderwoche: 2, Verkehrstag: "Sa+So", Verkehrsart: gemeinsameVerkehrsart, Abfahrt: { stunde: gemeinsameAbfahrtStunde, minute: 0 }, Ankunft: { stunde: gemeinsameAnkunftStunde, minute: 0 }, Grundentgelt: 150 });

        const erstellteSlots = [];
        let zugehoerigeTopfIds = new Set();

        for (const slotData of slotDefinitions) {
            const response = await request(app).post('/api/slots').send(slotData);
            expect(response.status).toBe(201);
            erstellteSlots.push(response.body.data);
            if (response.body.data.VerweisAufTopf) {
                zugehoerigeTopfIds.add(response.body.data.VerweisAufTopf.toString());
            }
        }
        expect(erstellteSlots).toHaveLength(8);
        expect(zugehoerigeTopfIds.size).toBe(8); // Erwartet 8 unterschiedliche, auto-erstellte Töpfe

        // ----- 2. Anfrage erstellen -----
        const anfrageData = {
            Zugnummer: "ICE200", EVU: "DB AG",
            ListeGewuenschterSlotAbschnitte: [
                { von: "A", bis: "B", Abfahrtszeit: { stunde: gemeinsameAbfahrtStunde, minute: 0 }, Ankunftszeit: { stunde: gemeinsameAnkunftStunde, minute: 0 } },
                { von: "B", bis: "C", Abfahrtszeit: { stunde: gemeinsameAbfahrtStunde, minute: 0 }, Ankunftszeit: { stunde: gemeinsameAnkunftStunde, minute: 0 } }
            ],
            Verkehrsart: gemeinsameVerkehrsart,
            Verkehrstag: "täglich",
            Zeitraum: {
                start: "2024-12-30", // Mo, 30.12.2024 (Start KW1)
                ende: "2025-01-12" // So, 12.01.2025 (Ende KW2)
            },
            Email: "test2@example.com",
            Status: "validiert",
            //ZugewieseneSlots: [], //hier muss noch alle Slot-IDs in das Feld ZugewieseneSlots hinterlegt werden
            //Entgelt: 4200
        };
        const anfrageErstelltResponse = await request(app).post('/api/anfragen').send(anfrageData);
        expect(anfrageErstelltResponse.status).toBe(201); // Annahme: POST /api/anfragen gibt 201 bei Erfolg
        let anfrageErstellt = anfrageErstelltResponse.body.data;
        anfrageErstellt = await Anfrage.findById(anfrageErstellt._id);
        //console.log(anfrageErstellt);
        anfrageErstellt.Status = 'validiert';
        await anfrageErstellt.save();
        expect(anfrageErstellt.Status).toBe("validiert");

        // ----- 3. Aktion: Zuordnungsprozess anstoßen -----
        const zuordnenResponse = await request(app)
            .post(`/api/anfragen/${anfrageErstellt._id}/zuordnen`)
            .send();

        expect(zuordnenResponse.status).toBe(200);
        const aktualisierteAnfrage = zuordnenResponse.body.data;
        expect(aktualisierteAnfrage.Status).toBe("in_konfliktpruefung");

        // ----- 4. Überprüfung -----
        // 4.1 Zugewiesene Slots in der Anfrage (sollten alle 8 sein)
        expect(aktualisierteAnfrage.ZugewieseneSlots).toHaveLength(8);
        // Überprüfe jeden Eintrag im `ZugewieseneSlots`-Array
        for (const slot of erstellteSlots) { // `erstellteSlots` enthält die vollen Slot-Objekte aus der Vorbereitung
            const zuweisungEintrag = aktualisierteAnfrage.ZugewieseneSlots.find(
                zs => zs.slot.toString() === slot._id.toString()
            );
            expect(zuweisungEintrag).toBeDefined(); // Stellt sicher, dass jeder erwartete Slot referenziert wird
            expect(zuweisungEintrag.statusEinzelzuweisung).toBe('initial_in_konfliktpruefung_topf');
        }

        // 4.2 Kapazitätstopf-Listen und 4.3 Slots zugewiesene Anfragen (bleiben im Prinzip gleich,
        // da diese auf den _id's basieren, die Logik der Aktualisierung dort ist unverändert)
        // ... (Assertions für Kapazitaetstopf.ListeDerAnfragen und Slot.zugewieseneAnfragen wie zuvor)
         zugehoerigeTopfIds = new Set(erstellteSlots.map(s => s.VerweisAufTopf.toString()));
         expect(zugehoerigeTopfIds.size).toBe(8);

         for (const topfId of zugehoerigeTopfIds) {
            const topf = await Kapazitaetstopf.findById(topfId);
            expect(topf.ListeDerAnfragen.map(id => id.toString())).toContain(anfrageErstellt._id.toString());
        }
        for (const slot of erstellteSlots) {
            const slot_final = await Slot.findById(slot._id);
            expect(slot_final.zugewieseneAnfragen.map(id => id.toString())).toContain(anfrageErstellt._id.toString());
        }

        // WICHTIG: Teste auch das berechnete Entgelt
        // Annahme: Alle 8 genutzten Slot-Muster haben Grundentgelt 150.
        // Die Anfrage läuft über 2 volle KWs "täglich", also 14 Tage.
        // Jeder der ZWEI Abschnitte der Anfrage wird an diesen 14 Tagen befahren.
        // Pro Tag kostet ein Abschnitt 150€. Summe pro Durchlauf = 150€ (Abschnitt1) + 150€ (Abschnitt2) = 300€.
        // Gesamtentgelt = 14 Tage * 300€/Tag = 4200€.
        const erwartetesEntgelt = 14 * (150 + 150); // 14 Tage * (Grundentgelt SlotTyp1 + Grundentgelt SlotTyp2)
        expect(aktualisierteAnfrage.Entgelt).toBe(erwartetesEntgelt);
    });

    // Testfall für 3 Anfragen und die Massen-Zuordnung mit dem neuen Endpunkt
    it('Szenario C (Massen-Operation): 3 Tägliche Anfragen (1 Abschnitt) über 2 KWs auf 4 Töpfe', async () => {
        // ----- 1. Vorbereitung: Slots erstellen (Töpfe werden auto-erstellt) -----
        const commonSlotParams = {
            slotTyp: 'TAG',
            von: "StadtA", bis: "StadtB", Abschnitt: "Hauptkorridor",
            Abfahrt: { stunde: 8, minute: 0 }, Ankunft: { stunde: 9, minute: 0 },
            Verkehrsart: "SPFV", Grundentgelt: 150
        };

        // Slots für KW1 (global relativ)
        const slotMoFrKW1Data = { ...commonSlotParams, Kalenderwoche: 1, Verkehrstag: "Mo-Fr" };
        const slotSaSoKW1Data = { ...commonSlotParams, Kalenderwoche: 1, Verkehrstag: "Sa+So" };
        // Slots für KW2 (global relativ)
        const slotMoFrKW2Data = { ...commonSlotParams, Kalenderwoche: 2, Verkehrstag: "Mo-Fr" };
        const slotSaSoKW2Data = { ...commonSlotParams, Kalenderwoche: 2, Verkehrstag: "Sa+So" };
        // Slots für KW3 (global relativ)
        const slotMoFrKW3Data = { ...commonSlotParams, Kalenderwoche: 3, Verkehrstag: "Mo-Fr" };
        const slotSaSoKW3Data = { ...commonSlotParams, Kalenderwoche: 3, Verkehrstag: "Sa+So" };

        const respSlot1 = await request(app).post('/api/slots').send(slotMoFrKW1Data);
        const respSlot2 = await request(app).post('/api/slots').send(slotSaSoKW1Data);
        const respSlot3 = await request(app).post('/api/slots').send(slotMoFrKW2Data);
        const respSlot4 = await request(app).post('/api/slots').send(slotSaSoKW2Data);
        const respSlot5 = await request(app).post('/api/slots').send(slotMoFrKW3Data);
        const respSlot6 = await request(app).post('/api/slots').send(slotSaSoKW3Data);

        expect(respSlot1.status).toBe(201); 
        expect(respSlot2.status).toBe(201);
        expect(respSlot3.status).toBe(201); 
        expect(respSlot4.status).toBe(201);
        expect(respSlot5.status).toBe(201); 
        expect(respSlot6.status).toBe(201);

        const slotMoFrKW1 = respSlot1.body.data;
        const slotSaSoKW1 = respSlot2.body.data;
        const slotMoFrKW2 = respSlot3.body.data;
        const slotSaSoKW2 = respSlot4.body.data;
        const slotMoFrKW3 = respSlot5.body.data;
        const slotSaSoKW3 = respSlot6.body.data;

        // IDs der automatisch erstellten/gefundenen Kapazitätstöpfe holen
        const ktMoFrKW1_Id = slotMoFrKW1.VerweisAufTopf;
        const ktSaSoKW1_Id = slotSaSoKW1.VerweisAufTopf;
        const ktMoFrKW2_Id = slotMoFrKW2.VerweisAufTopf;
        const ktSaSoKW2_Id = slotSaSoKW2.VerweisAufTopf;
        const ktMoFrKW3_Id = slotMoFrKW3.VerweisAufTopf;
        const ktSaSoKW3_Id = slotSaSoKW3.VerweisAufTopf;

        expect(ktMoFrKW1_Id).toBeDefined(); 
        expect(ktSaSoKW1_Id).toBeDefined();
        expect(ktMoFrKW2_Id).toBeDefined(); 
        expect(ktSaSoKW2_Id).toBeDefined();
        expect(ktMoFrKW3_Id).toBeDefined(); 
        expect(ktSaSoKW3_Id).toBeDefined();
        // Sicherstellen, dass es vier unterschiedliche Töpfe sind (aufgrund KW und Verkehrstag)
        const topfIds = new Set([ktMoFrKW1_Id, ktSaSoKW1_Id, ktMoFrKW2_Id, ktSaSoKW2_Id, ktMoFrKW3_Id, ktSaSoKW3_Id]);
        expect(topfIds.size).toBe(6);


        // ----- 2. Anfrage erstellen -----
        const anfrageData = {
            EVU: "DB Fernverkehr AG",
            ListeGewuenschterSlotAbschnitte: [{
                von: "StadtA", bis: "StadtB",
                Abfahrtszeit: { stunde: 8, minute: 0 }, Ankunftszeit: { stunde: 9, minute: 0 }
            }],
            Verkehrsart: "SPFV",
            Verkehrstag: "täglich",
            Zeitraum: {
                start: "2024-12-30", // Mo, 30.12.2024 (Start KW1)
                ende: "2025-01-12" // So, 12.01.2025 (Ende KW2)
            },
            Email: "test@example.com",
            Status: "validiert", // Wir erstellen sie direkt als 'validiert' für diesen Test
            //ZugewieseneSlots: [slotMoFrKW1._id, slotSaSoKW1._id, slotMoFrKW2._id, slotSaSoKW2._id], //hier muss noch alle Slot-IDs in das Feld ZugewieseneSlots hinterlegt werden
            //Entgelt: 2100
        };
        // Man wird eine Anfrage mit POST /api/anfragen erstellt
        // und dann den Status auf 'validiert' setzen, falls die Erstellung nicht direkt 'validiert' erlaubt.
        // Hier nehmen wir an, sie kann als 'validiert' erstellt werden oder wir setzen den Status manuell in der DB.
        const anfrageErstelltResponse = await request(app).post('/api/anfragen').send({...anfrageData, Zugnummer: "100"});
        expect(anfrageErstelltResponse.status).toBe(201); // Annahme: POST /api/anfragen gibt 201 bei Erfolg
        let anfrageErstellt = anfrageErstelltResponse.body.data;
        anfrageErstellt = await Anfrage.findById(anfrageErstellt._id);
        //console.log(anfrageErstellt);
        anfrageErstellt.Status = 'validiert';
        await anfrageErstellt.save();
        expect(anfrageErstellt.Status).toBe("validiert");

        const anfrageErstelltResponse2 = await request(app).post('/api/anfragen').send({...anfrageData, Zugnummer: "200"});
        expect(anfrageErstelltResponse2.status).toBe(201); // Annahme: POST /api/anfragen gibt 201 bei Erfolg
        let anfrageErstellt2 = anfrageErstelltResponse2.body.data;
        anfrageErstellt2 = await Anfrage.findById(anfrageErstellt2._id);
        //console.log(anfrageErstellt2);
        anfrageErstellt2.Status = 'validiert';
        await anfrageErstellt2.save();
        expect(anfrageErstellt2.Status).toBe("validiert");

        const anfrageErstelltResponse3 = await request(app).post('/api/anfragen').send({...anfrageData, Zugnummer: "300"});
        expect(anfrageErstelltResponse3.status).toBe(201); // Annahme: POST /api/anfragen gibt 201 bei Erfolg
        let anfrageErstellt3 = anfrageErstelltResponse3.body.data;
        anfrageErstellt3 = await Anfrage.findById(anfrageErstellt3._id);
        //console.log(anfrageErstellt3);
        anfrageErstellt3.Status = 'validiert';
        await anfrageErstellt3.save();
        expect(anfrageErstellt3.Status).toBe("validiert");


        // ----- 3. Aktion: Zuordnungsprozess anstoßen -----
        const zuordnenResponse = await request(app)
            .post(`/api/anfragen/zuordnen/alle-validierten`)
            .send();

        //console.log(zuordnenResponse);
        expect(zuordnenResponse.status).toBe(200);
        const summary = zuordnenResponse.body.summary;
        expect(summary.total).toBe(3);
        expect(summary.success).toBe(3);
        expect(summary.failed).toBe(0);

        anfrageErstellt = await Anfrage.findById(anfrageErstellt._id);
        anfrageErstellt2 = await Anfrage.findById(anfrageErstellt2._id);
        anfrageErstellt3 = await Anfrage.findById(anfrageErstellt3._id);

        // ----- 4. Überprüfung -----
        // 4.1 Zugewiesene Slots in der Anfrage
        expect(anfrageErstellt.ZugewieseneSlots).toHaveLength(4);
        const zugewieseneSlotIdsInAnfrage = anfrageErstellt.ZugewieseneSlots.map(obj => obj.slot.toString());
        expect(zugewieseneSlotIdsInAnfrage).toContain(slotMoFrKW1._id.toString());
        expect(zugewieseneSlotIdsInAnfrage).toContain(slotSaSoKW1._id.toString());
        expect(zugewieseneSlotIdsInAnfrage).toContain(slotMoFrKW2._id.toString());
        expect(zugewieseneSlotIdsInAnfrage).toContain(slotSaSoKW2._id.toString());
        const zugewieseneSlotStatusInAnfrage = anfrageErstellt.ZugewieseneSlots.map(obj => obj.statusEinzelzuweisung);
        expect(new Set(zugewieseneSlotStatusInAnfrage).size).toBe(1);
        expect(zugewieseneSlotStatusInAnfrage[0]).toBe('initial_in_konfliktpruefung_topf');
        //expect([1,1,1,1].every( (val, i, zugewieseneSlotStatusInAnfrage) => val === zugewieseneSlotStatusInAnfrage[0] )).toBe(true);

        // 4.2 Kapazitätstopf-Listen
        const ktMoFrKW1_final = await Kapazitaetstopf.findById(ktMoFrKW1_Id);
        const ktSaSoKW1_final = await Kapazitaetstopf.findById(ktSaSoKW1_Id);
        const ktMoFrKW2_final = await Kapazitaetstopf.findById(ktMoFrKW2_Id);
        const ktSaSoKW2_final = await Kapazitaetstopf.findById(ktSaSoKW2_Id);
        const ktMoFrKW3_final = await Kapazitaetstopf.findById(ktMoFrKW3_Id);
        const ktSaSoKW3_final = await Kapazitaetstopf.findById(ktSaSoKW3_Id);

        expect(ktMoFrKW1_final.ListeDerAnfragen.map(id => id.toString())).toContain(anfrageErstellt._id.toString());
        expect(ktSaSoKW1_final.ListeDerAnfragen.map(id => id.toString())).toContain(anfrageErstellt._id.toString());
        expect(ktMoFrKW2_final.ListeDerAnfragen.map(id => id.toString())).toContain(anfrageErstellt._id.toString());
        expect(ktSaSoKW2_final.ListeDerAnfragen.map(id => id.toString())).toContain(anfrageErstellt._id.toString());
        expect(ktMoFrKW1_final.ListeDerAnfragen.map(id => id.toString())).toContain(anfrageErstellt2._id.toString());
        expect(ktSaSoKW1_final.ListeDerAnfragen.map(id => id.toString())).toContain(anfrageErstellt2._id.toString());
        expect(ktMoFrKW2_final.ListeDerAnfragen.map(id => id.toString())).toContain(anfrageErstellt2._id.toString());
        expect(ktSaSoKW2_final.ListeDerAnfragen.map(id => id.toString())).toContain(anfrageErstellt2._id.toString());
        expect(ktMoFrKW1_final.ListeDerAnfragen.map(id => id.toString())).toContain(anfrageErstellt3._id.toString());
        expect(ktSaSoKW1_final.ListeDerAnfragen.map(id => id.toString())).toContain(anfrageErstellt3._id.toString());
        expect(ktMoFrKW2_final.ListeDerAnfragen.map(id => id.toString())).toContain(anfrageErstellt3._id.toString());
        expect(ktSaSoKW2_final.ListeDerAnfragen.map(id => id.toString())).toContain(anfrageErstellt3._id.toString());
        expect(ktMoFrKW3_final.ListeDerAnfragen.length).toBe(0);
        expect(ktSaSoKW3_final.ListeDerAnfragen.length).toBe(0);

        // 4.3 Slots zugewiesene Anfragen
        const slot1_final = await Slot.findById(slotMoFrKW1._id);
        const slot2_final = await Slot.findById(slotSaSoKW1._id);
        const slot3_final = await Slot.findById(slotMoFrKW2._id);
        const slot4_final = await Slot.findById(slotSaSoKW2._id);
        const slot5_final = await Slot.findById(slotMoFrKW3._id);
        const slot6_final = await Slot.findById(slotSaSoKW3._id);

        expect(slot1_final.zugewieseneAnfragen.map(id => id.toString())).toContain(anfrageErstellt._id.toString());
        expect(slot2_final.zugewieseneAnfragen.map(id => id.toString())).toContain(anfrageErstellt._id.toString());
        expect(slot3_final.zugewieseneAnfragen.map(id => id.toString())).toContain(anfrageErstellt._id.toString());
        expect(slot4_final.zugewieseneAnfragen.map(id => id.toString())).toContain(anfrageErstellt._id.toString());
        expect(slot1_final.zugewieseneAnfragen.map(id => id.toString())).toContain(anfrageErstellt2._id.toString());
        expect(slot2_final.zugewieseneAnfragen.map(id => id.toString())).toContain(anfrageErstellt2._id.toString());
        expect(slot3_final.zugewieseneAnfragen.map(id => id.toString())).toContain(anfrageErstellt2._id.toString());
        expect(slot4_final.zugewieseneAnfragen.map(id => id.toString())).toContain(anfrageErstellt2._id.toString());
        expect(slot1_final.zugewieseneAnfragen.map(id => id.toString())).toContain(anfrageErstellt3._id.toString());
        expect(slot2_final.zugewieseneAnfragen.map(id => id.toString())).toContain(anfrageErstellt3._id.toString());
        expect(slot3_final.zugewieseneAnfragen.map(id => id.toString())).toContain(anfrageErstellt3._id.toString());
        expect(slot4_final.zugewieseneAnfragen.map(id => id.toString())).toContain(anfrageErstellt3._id.toString());
        expect(slot5_final.zugewieseneAnfragen.length).toBe(0);
        expect(slot6_final.zugewieseneAnfragen.length).toBe(0);

        // WICHTIG: Teste auch das berechnete Entgelt
        // Annahme: Alle 4 genutzten Slot-Muster haben Grundentgelt 150.
        // Die Anfrage läuft über 2 volle KWs "täglich", also 14 Tage.
        // Jeder Abschnitt der Anfrage wird an diesen 14 Tagen befahren.
        // Pro Tag kostet ein Abschnitt 150€. Summe pro Durchlauf = 150€ (für den einen Abschnitt).
        // Gesamtentgelt = 14 Tage * 150€/Tag = 2100€.
        const erwartetesEntgelt = 14 * (150); // 14 Tage * (Grundentgelt SlotTyp)
        expect(anfrageErstellt.Entgelt).toBe(erwartetesEntgelt);
        expect(anfrageErstellt2.Entgelt).toBe(erwartetesEntgelt);
        expect(anfrageErstellt3.Entgelt).toBe(erwartetesEntgelt);
    });

    // Testfall für 3 Anfragen und die Massen-Zuordnung mit dem neuen Endpunkt
    it('Szenario D (Massen-Operation): 3 Tägliche Anfragen (1 Abschnitt Tag und 1 Abschnitt Nacht) über 2 KWs auf 4 Töpfe', async () => {
        // ----- 1. Vorbereitung: Slots erstellen (Töpfe werden auto-erstellt) -----
        const commonSlotParams1 = {
            slotTyp: 'TAG',
            von: "StadtA", bis: "StadtB", Abschnitt: "Hauptkorridor1",
            Abfahrt: { stunde: 22, minute: 0 }, Ankunft: { stunde: 23, minute: 0 },
            Verkehrsart: "SPFV", Grundentgelt: 150
        };

        const commonSlotParams2 = {
            slotTyp: 'NACHT',
            von: "StadtB", bis: "StadtC", Abschnitt: "Hauptkorridor2",
            Zeitfenster: '23-01',
            Mindestfahrzeit: 60,
            Maximalfahrzeit: 80,
            Grundentgelt: 150
        };

        // Slots für KW1 (global relativ)
        const slotMoFrKW1Data1 = { ...commonSlotParams1, Kalenderwoche: 1, Verkehrstag: "Mo-Fr" };
        const slotSaSoKW1Data1 = { ...commonSlotParams1, Kalenderwoche: 1, Verkehrstag: "Sa+So" };
        const slotMoFrKW1Data2 = { ...commonSlotParams2, Kalenderwoche: 1, Verkehrstag: "Mo-Fr" };
        const slotSaSoKW1Data2 = { ...commonSlotParams2, Kalenderwoche: 1, Verkehrstag: "Sa+So" };
        // Slots für KW2 (global relativ)
        const slotMoFrKW2Data1 = { ...commonSlotParams1, Kalenderwoche: 2, Verkehrstag: "Mo-Fr" };
        const slotSaSoKW2Data1 = { ...commonSlotParams1, Kalenderwoche: 2, Verkehrstag: "Sa+So" };
        const slotMoFrKW2Data2 = { ...commonSlotParams2, Kalenderwoche: 2, Verkehrstag: "Mo-Fr" };
        const slotSaSoKW2Data2 = { ...commonSlotParams2, Kalenderwoche: 2, Verkehrstag: "Sa+So" };

        const respSlot1 = await request(app).post('/api/slots').send(slotMoFrKW1Data1);
        const respSlot2 = await request(app).post('/api/slots').send(slotSaSoKW1Data1);
        const respSlot3 = await request(app).post('/api/slots').send(slotMoFrKW2Data1);
        const respSlot4 = await request(app).post('/api/slots').send(slotSaSoKW2Data1);
        const respSlot5 = await request(app).post('/api/slots').send(slotMoFrKW1Data2);
        const respSlot6 = await request(app).post('/api/slots').send(slotSaSoKW1Data2);
        const respSlot7 = await request(app).post('/api/slots').send(slotMoFrKW2Data2);
        const respSlot8 = await request(app).post('/api/slots').send(slotSaSoKW2Data2);

        expect(respSlot1.status).toBe(201); 
        expect(respSlot2.status).toBe(201);
        expect(respSlot3.status).toBe(201); 
        expect(respSlot4.status).toBe(201);
        expect(respSlot5.status).toBe(201); 
        expect(respSlot6.status).toBe(201);
        expect(respSlot7.status).toBe(201); 
        expect(respSlot8.status).toBe(201);

        const slotMoFrKW1_1 = respSlot1.body.data;
        const slotSaSoKW1_1 = respSlot2.body.data;
        const slotMoFrKW2_1 = respSlot3.body.data;
        const slotSaSoKW2_1 = respSlot4.body.data;
        const slotMoFrKW1_2 = respSlot5.body.data;
        const slotSaSoKW1_2 = respSlot6.body.data;
        const slotMoFrKW2_2 = respSlot7.body.data;
        const slotSaSoKW2_2 = respSlot8.body.data;

        // IDs der automatisch erstellten/gefundenen Kapazitätstöpfe holen
        const ktMoFrKW1_Id1 = slotMoFrKW1_1.VerweisAufTopf;
        const ktSaSoKW1_Id1 = slotSaSoKW1_1.VerweisAufTopf;
        const ktMoFrKW2_Id1 = slotMoFrKW2_1.VerweisAufTopf;
        const ktSaSoKW2_Id1 = slotSaSoKW2_1.VerweisAufTopf;
        const ktMoFrKW1_Id2 = slotMoFrKW1_2.VerweisAufTopf;
        const ktSaSoKW1_Id2 = slotSaSoKW1_2.VerweisAufTopf;
        const ktMoFrKW2_Id2 = slotMoFrKW2_2.VerweisAufTopf;
        const ktSaSoKW2_Id2 = slotSaSoKW2_2.VerweisAufTopf;

        expect(ktMoFrKW1_Id1).toBeDefined(); 
        expect(ktSaSoKW1_Id1).toBeDefined();
        expect(ktMoFrKW2_Id1).toBeDefined(); 
        expect(ktSaSoKW2_Id1).toBeDefined();
        expect(ktMoFrKW1_Id2).toBeDefined(); 
        expect(ktSaSoKW1_Id2).toBeDefined();
        expect(ktMoFrKW2_Id2).toBeDefined(); 
        expect(ktSaSoKW2_Id2).toBeDefined();
        // Sicherstellen, dass es vier unterschiedliche Töpfe sind (aufgrund KW und Verkehrstag)
        const topfIds = new Set([ktMoFrKW1_Id1, ktSaSoKW1_Id1, ktMoFrKW2_Id1, ktSaSoKW2_Id1, ktMoFrKW1_Id2, ktSaSoKW1_Id2, ktMoFrKW2_Id2, ktSaSoKW2_Id2]);
        expect(topfIds.size).toBe(8);


        // ----- 2. Anfrage erstellen -----
        const anfrageData = {
            EVU: "DB Fernverkehr AG",
            ListeGewuenschterSlotAbschnitte: [
                {
                von: "StadtA", bis: "StadtB",
                Abfahrtszeit: { stunde: 22, minute: 0 }, Ankunftszeit: { stunde: 23, minute: 0 }
                },
                {
                von: "StadtB", bis: "StadtC",
                Abfahrtszeit: { stunde: 23, minute: 10 }, Ankunftszeit: { stunde: 0, minute: 25 }
                },
            ],
            Verkehrsart: "SPFV",
            Verkehrstag: "täglich",
            Zeitraum: {
                start: "2024-12-30", // Mo, 30.12.2024 (Start KW1)
                ende: "2025-01-12" // So, 12.01.2025 (Ende KW2)
            },
            Email: "test@example.com",
            Status: "validiert", // Wir erstellen sie direkt als 'validiert' für diesen Test
            //ZugewieseneSlots: [slotMoFrKW1._id, slotSaSoKW1._id, slotMoFrKW2._id, slotSaSoKW2._id], //hier muss noch alle Slot-IDs in das Feld ZugewieseneSlots hinterlegt werden
            //Entgelt: 4200
        };
        // Man wird eine Anfrage mit POST /api/anfragen erstellt
        // und dann den Status auf 'validiert' setzen, falls die Erstellung nicht direkt 'validiert' erlaubt.
        // Hier nehmen wir an, sie kann als 'validiert' erstellt werden oder wir setzen den Status manuell in der DB.
        const anfrageErstelltResponse = await request(app).post('/api/anfragen').send({...anfrageData, Zugnummer: "100"});
        expect(anfrageErstelltResponse.status).toBe(201); // Annahme: POST /api/anfragen gibt 201 bei Erfolg
        let anfrageErstellt = anfrageErstelltResponse.body.data;
        anfrageErstellt = await Anfrage.findById(anfrageErstellt._id);
        //console.log(anfrageErstellt);
        anfrageErstellt.Status = 'validiert';
        await anfrageErstellt.save();
        expect(anfrageErstellt.Status).toBe("validiert");

        const anfrageErstelltResponse2 = await request(app).post('/api/anfragen').send({...anfrageData, Zugnummer: "200"});
        expect(anfrageErstelltResponse2.status).toBe(201); // Annahme: POST /api/anfragen gibt 201 bei Erfolg
        let anfrageErstellt2 = anfrageErstelltResponse2.body.data;
        anfrageErstellt2 = await Anfrage.findById(anfrageErstellt2._id);
        //console.log(anfrageErstellt2);
        anfrageErstellt2.Status = 'validiert';
        await anfrageErstellt2.save();
        expect(anfrageErstellt2.Status).toBe("validiert");

        const anfrageErstelltResponse3 = await request(app).post('/api/anfragen').send({...anfrageData, Zugnummer: "300"});
        expect(anfrageErstelltResponse3.status).toBe(201); // Annahme: POST /api/anfragen gibt 201 bei Erfolg
        let anfrageErstellt3 = anfrageErstelltResponse3.body.data;
        anfrageErstellt3 = await Anfrage.findById(anfrageErstellt3._id);
        //console.log(anfrageErstellt3);
        anfrageErstellt3.Status = 'validiert';
        await anfrageErstellt3.save();
        expect(anfrageErstellt3.Status).toBe("validiert");


        // ----- 3. Aktion: Zuordnungsprozess anstoßen -----
        const zuordnenResponse = await request(app)
            .post(`/api/anfragen/zuordnen/alle-validierten`)
            .send();

        //console.log(zuordnenResponse);
        expect(zuordnenResponse.status).toBe(200);
        const summary = zuordnenResponse.body.summary;
        expect(summary.total).toBe(3);
        expect(summary.success).toBe(3);
        expect(summary.failed).toBe(0);

        anfrageErstellt = await Anfrage.findById(anfrageErstellt._id);
        anfrageErstellt2 = await Anfrage.findById(anfrageErstellt2._id);
        anfrageErstellt3 = await Anfrage.findById(anfrageErstellt3._id);

        // ----- 4. Überprüfung -----
        // 4.1 Zugewiesene Slots in der Anfrage
        expect(anfrageErstellt.ZugewieseneSlots).toHaveLength(8);
        const zugewieseneSlotIdsInAnfrage = anfrageErstellt.ZugewieseneSlots.map(obj => obj.slot.toString());
        expect(zugewieseneSlotIdsInAnfrage).toContain(slotMoFrKW1_1._id.toString());
        expect(zugewieseneSlotIdsInAnfrage).toContain(slotSaSoKW1_1._id.toString());
        expect(zugewieseneSlotIdsInAnfrage).toContain(slotMoFrKW2_1._id.toString());
        expect(zugewieseneSlotIdsInAnfrage).toContain(slotSaSoKW2_1._id.toString());
        expect(zugewieseneSlotIdsInAnfrage).toContain(slotMoFrKW1_2._id.toString());
        expect(zugewieseneSlotIdsInAnfrage).toContain(slotSaSoKW1_2._id.toString());
        expect(zugewieseneSlotIdsInAnfrage).toContain(slotMoFrKW2_2._id.toString());
        expect(zugewieseneSlotIdsInAnfrage).toContain(slotSaSoKW2_2._id.toString());
        const zugewieseneSlotStatusInAnfrage = anfrageErstellt.ZugewieseneSlots.map(obj => obj.statusEinzelzuweisung);
        expect(new Set(zugewieseneSlotStatusInAnfrage).size).toBe(1);
        expect(zugewieseneSlotStatusInAnfrage[0]).toBe('initial_in_konfliktpruefung_topf');
        //expect([1,1,1,1].every( (val, i, zugewieseneSlotStatusInAnfrage) => val === zugewieseneSlotStatusInAnfrage[0] )).toBe(true);

        // 4.2 Kapazitätstopf-Listen
        const ktMoFrKW1_final1 = await Kapazitaetstopf.findById(ktMoFrKW1_Id1);
        const ktSaSoKW1_final1 = await Kapazitaetstopf.findById(ktSaSoKW1_Id1);
        const ktMoFrKW2_final1 = await Kapazitaetstopf.findById(ktMoFrKW2_Id1);
        const ktSaSoKW2_final1 = await Kapazitaetstopf.findById(ktSaSoKW2_Id1);
        const ktMoFrKW1_final2 = await Kapazitaetstopf.findById(ktMoFrKW1_Id2);
        const ktSaSoKW1_final2 = await Kapazitaetstopf.findById(ktSaSoKW1_Id2);
        const ktMoFrKW2_final2 = await Kapazitaetstopf.findById(ktMoFrKW2_Id2);
        const ktSaSoKW2_final2 = await Kapazitaetstopf.findById(ktSaSoKW2_Id2);

        expect(ktMoFrKW1_final1.ListeDerAnfragen.map(id => id.toString())).toContain(anfrageErstellt._id.toString());
        expect(ktSaSoKW1_final1.ListeDerAnfragen.map(id => id.toString())).toContain(anfrageErstellt._id.toString());
        expect(ktMoFrKW2_final1.ListeDerAnfragen.map(id => id.toString())).toContain(anfrageErstellt._id.toString());
        expect(ktSaSoKW2_final1.ListeDerAnfragen.map(id => id.toString())).toContain(anfrageErstellt._id.toString());
        expect(ktMoFrKW1_final1.ListeDerAnfragen.map(id => id.toString())).toContain(anfrageErstellt2._id.toString());
        expect(ktSaSoKW1_final1.ListeDerAnfragen.map(id => id.toString())).toContain(anfrageErstellt2._id.toString());
        expect(ktMoFrKW2_final1.ListeDerAnfragen.map(id => id.toString())).toContain(anfrageErstellt2._id.toString());
        expect(ktSaSoKW2_final1.ListeDerAnfragen.map(id => id.toString())).toContain(anfrageErstellt2._id.toString());
        expect(ktMoFrKW1_final1.ListeDerAnfragen.map(id => id.toString())).toContain(anfrageErstellt3._id.toString());
        expect(ktSaSoKW1_final1.ListeDerAnfragen.map(id => id.toString())).toContain(anfrageErstellt3._id.toString());
        expect(ktMoFrKW2_final1.ListeDerAnfragen.map(id => id.toString())).toContain(anfrageErstellt3._id.toString());
        expect(ktSaSoKW2_final1.ListeDerAnfragen.map(id => id.toString())).toContain(anfrageErstellt3._id.toString());

        expect(ktMoFrKW1_final2.ListeDerAnfragen.map(id => id.toString())).toContain(anfrageErstellt._id.toString());
        expect(ktSaSoKW1_final2.ListeDerAnfragen.map(id => id.toString())).toContain(anfrageErstellt._id.toString());
        expect(ktMoFrKW2_final2.ListeDerAnfragen.map(id => id.toString())).toContain(anfrageErstellt._id.toString());
        expect(ktSaSoKW2_final2.ListeDerAnfragen.map(id => id.toString())).toContain(anfrageErstellt._id.toString());
        expect(ktMoFrKW1_final2.ListeDerAnfragen.map(id => id.toString())).toContain(anfrageErstellt2._id.toString());
        expect(ktSaSoKW1_final2.ListeDerAnfragen.map(id => id.toString())).toContain(anfrageErstellt2._id.toString());
        expect(ktMoFrKW2_final2.ListeDerAnfragen.map(id => id.toString())).toContain(anfrageErstellt2._id.toString());
        expect(ktSaSoKW2_final2.ListeDerAnfragen.map(id => id.toString())).toContain(anfrageErstellt2._id.toString());
        expect(ktMoFrKW1_final2.ListeDerAnfragen.map(id => id.toString())).toContain(anfrageErstellt3._id.toString());
        expect(ktSaSoKW1_final2.ListeDerAnfragen.map(id => id.toString())).toContain(anfrageErstellt3._id.toString());
        expect(ktMoFrKW2_final2.ListeDerAnfragen.map(id => id.toString())).toContain(anfrageErstellt3._id.toString());
        expect(ktSaSoKW2_final2.ListeDerAnfragen.map(id => id.toString())).toContain(anfrageErstellt3._id.toString());

        // 4.3 Slots zugewiesene Anfragen
        const slot1_final1 = await Slot.findById(slotMoFrKW1_1._id);
        const slot2_final1 = await Slot.findById(slotSaSoKW1_1._id);
        const slot3_final1 = await Slot.findById(slotMoFrKW2_1._id);
        const slot4_final1 = await Slot.findById(slotSaSoKW2_1._id);
        const slot1_final2 = await Slot.findById(slotMoFrKW1_2._id);
        const slot2_final2 = await Slot.findById(slotSaSoKW1_2._id);
        const slot3_final2 = await Slot.findById(slotMoFrKW2_2._id);
        const slot4_final2 = await Slot.findById(slotSaSoKW2_2._id);

        expect(slot1_final1.zugewieseneAnfragen.map(id => id.toString())).toContain(anfrageErstellt._id.toString());
        expect(slot2_final1.zugewieseneAnfragen.map(id => id.toString())).toContain(anfrageErstellt._id.toString());
        expect(slot3_final1.zugewieseneAnfragen.map(id => id.toString())).toContain(anfrageErstellt._id.toString());
        expect(slot4_final1.zugewieseneAnfragen.map(id => id.toString())).toContain(anfrageErstellt._id.toString());
        expect(slot1_final1.zugewieseneAnfragen.map(id => id.toString())).toContain(anfrageErstellt2._id.toString());
        expect(slot2_final1.zugewieseneAnfragen.map(id => id.toString())).toContain(anfrageErstellt2._id.toString());
        expect(slot3_final1.zugewieseneAnfragen.map(id => id.toString())).toContain(anfrageErstellt2._id.toString());
        expect(slot4_final1.zugewieseneAnfragen.map(id => id.toString())).toContain(anfrageErstellt2._id.toString());
        expect(slot1_final1.zugewieseneAnfragen.map(id => id.toString())).toContain(anfrageErstellt3._id.toString());
        expect(slot2_final1.zugewieseneAnfragen.map(id => id.toString())).toContain(anfrageErstellt3._id.toString());
        expect(slot3_final1.zugewieseneAnfragen.map(id => id.toString())).toContain(anfrageErstellt3._id.toString());
        expect(slot4_final1.zugewieseneAnfragen.map(id => id.toString())).toContain(anfrageErstellt3._id.toString());

        expect(slot1_final2.zugewieseneAnfragen.map(id => id.toString())).toContain(anfrageErstellt._id.toString());
        expect(slot2_final2.zugewieseneAnfragen.map(id => id.toString())).toContain(anfrageErstellt._id.toString());
        expect(slot3_final2.zugewieseneAnfragen.map(id => id.toString())).toContain(anfrageErstellt._id.toString());
        expect(slot4_final2.zugewieseneAnfragen.map(id => id.toString())).toContain(anfrageErstellt._id.toString());
        expect(slot1_final2.zugewieseneAnfragen.map(id => id.toString())).toContain(anfrageErstellt2._id.toString());
        expect(slot2_final2.zugewieseneAnfragen.map(id => id.toString())).toContain(anfrageErstellt2._id.toString());
        expect(slot3_final2.zugewieseneAnfragen.map(id => id.toString())).toContain(anfrageErstellt2._id.toString());
        expect(slot4_final2.zugewieseneAnfragen.map(id => id.toString())).toContain(anfrageErstellt2._id.toString());
        expect(slot1_final2.zugewieseneAnfragen.map(id => id.toString())).toContain(anfrageErstellt3._id.toString());
        expect(slot2_final2.zugewieseneAnfragen.map(id => id.toString())).toContain(anfrageErstellt3._id.toString());
        expect(slot3_final2.zugewieseneAnfragen.map(id => id.toString())).toContain(anfrageErstellt3._id.toString());
        expect(slot4_final2.zugewieseneAnfragen.map(id => id.toString())).toContain(anfrageErstellt3._id.toString());

        // WICHTIG: Teste auch das berechnete Entgelt
        // Annahme: Alle 4 genutzten Slot-Muster haben Grundentgelt 150.
        // Die Anfrage läuft über 2 volle KWs "täglich", also 14 Tage.
        // Jeder Abschnitt der Anfrage wird an diesen 14 Tagen befahren.
        // Pro Tag kostet ein Abschnitt 150€. Summe pro Durchlauf = 300€ (für den beide Abschnitte).
        // Gesamtentgelt = 14 Tage * 300€/Tag = 4200€.
        const erwartetesEntgelt = 14 * (300); // 14 Tage * (Grundentgelt SlotTyp)
        expect(anfrageErstellt.Entgelt).toBe(erwartetesEntgelt);
        expect(anfrageErstellt2.Entgelt).toBe(erwartetesEntgelt);
        expect(anfrageErstellt3.Entgelt).toBe(erwartetesEntgelt);
    });

    // Testfall für 3 Anfragen und die Massen-Zuordnung mit dem neuen Endpunkt
    it('Szenario E 3 Anfragen 2xSaSo, 1xMoFr 1 Abschnitt Tag und 2 Abschnitte Nacht mit Tageswechsel mit 2 KWs auf 4 Toepfe', async () => {
        // ----- 1. Vorbereitung: Slots erstellen (Töpfe werden auto-erstellt) -----
        // Wir brauchen den Topf Mo-Fr für KW 3, da durch den Tageswechsel der letze Slot am Sonntag 
        // in den Mo-Fr Slot von 01-03 auf dem 3. Abschnitt C-D hineinragt. Die anderen 
        // Töpfe (Mo-Fr A-B und B-C) Sa+So (C-D) in KW 3 bleiben ohne Belegung
        const commonSlotParams1 = {
            slotTyp: 'TAG',
            von: "StadtA", bis: "StadtB", Abschnitt: "Hauptkorridor1",
            Abfahrt: { stunde: 22, minute: 30 }, Ankunft: { stunde: 23, minute: 30 },
            Verkehrsart: "SPFV", Grundentgelt: 150
        };

        const commonSlotParams2 = {
            slotTyp: 'NACHT',
            von: "StadtB", bis: "StadtC", Abschnitt: "Hauptkorridor2",
            Zeitfenster: '23-01',
            Mindestfahrzeit: 20,
            Maximalfahrzeit: 80,
            Grundentgelt: 150
        };

        const commonSlotParams3 = {
            slotTyp: 'NACHT',
            von: "StadtC", bis: "StadtD", Abschnitt: "Hauptkorridor3",
            Zeitfenster: '01-03',
            Mindestfahrzeit: 60,
            Maximalfahrzeit: 80,
            Grundentgelt: 150
        };

        // Slots für KW1 (global relativ)
        const slotMoFrKW1Data1 = { ...commonSlotParams1, Kalenderwoche: 1, Verkehrstag: "Mo-Fr" };
        const slotSaSoKW1Data1 = { ...commonSlotParams1, Kalenderwoche: 1, Verkehrstag: "Sa+So" };
        const slotMoFrKW1Data2 = { ...commonSlotParams2, Kalenderwoche: 1, Verkehrstag: "Mo-Fr" };
        const slotSaSoKW1Data2 = { ...commonSlotParams2, Kalenderwoche: 1, Verkehrstag: "Sa+So" };
        const slotMoFrKW1Data3 = { ...commonSlotParams3, Kalenderwoche: 1, Verkehrstag: "Mo-Fr" };
        const slotSaSoKW1Data3 = { ...commonSlotParams3, Kalenderwoche: 1, Verkehrstag: "Sa+So" };
        // Slots für KW2 (global relativ)
        const slotMoFrKW2Data1 = { ...commonSlotParams1, Kalenderwoche: 2, Verkehrstag: "Mo-Fr" };
        const slotSaSoKW2Data1 = { ...commonSlotParams1, Kalenderwoche: 2, Verkehrstag: "Sa+So" };
        const slotMoFrKW2Data2 = { ...commonSlotParams2, Kalenderwoche: 2, Verkehrstag: "Mo-Fr" };
        const slotSaSoKW2Data2 = { ...commonSlotParams2, Kalenderwoche: 2, Verkehrstag: "Sa+So" };
        const slotMoFrKW2Data3 = { ...commonSlotParams3, Kalenderwoche: 2, Verkehrstag: "Mo-Fr" };
        const slotSaSoKW2Data3 = { ...commonSlotParams3, Kalenderwoche: 2, Verkehrstag: "Sa+So" };

        // Slots für KW3 (global relativ)
        const slotMoFrKW3Data1 = { ...commonSlotParams1, Kalenderwoche: 3, Verkehrstag: "Mo-Fr" };
        const slotSaSoKW3Data1 = { ...commonSlotParams1, Kalenderwoche: 3, Verkehrstag: "Sa+So" };
        const slotMoFrKW3Data2 = { ...commonSlotParams2, Kalenderwoche: 3, Verkehrstag: "Mo-Fr" };
        const slotSaSoKW3Data2 = { ...commonSlotParams2, Kalenderwoche: 3, Verkehrstag: "Sa+So" };
        const slotMoFrKW3Data3 = { ...commonSlotParams3, Kalenderwoche: 3, Verkehrstag: "Mo-Fr" };
        const slotSaSoKW3Data3 = { ...commonSlotParams3, Kalenderwoche: 3, Verkehrstag: "Sa+So" };

        const respSlot1 = await request(app).post('/api/slots').send(slotMoFrKW1Data1);
        const respSlot2 = await request(app).post('/api/slots').send(slotSaSoKW1Data1);
        const respSlot3 = await request(app).post('/api/slots').send(slotMoFrKW2Data1);
        const respSlot4 = await request(app).post('/api/slots').send(slotSaSoKW2Data1);
        const respSlot5 = await request(app).post('/api/slots').send(slotMoFrKW1Data2);
        const respSlot6 = await request(app).post('/api/slots').send(slotSaSoKW1Data2);
        const respSlot7 = await request(app).post('/api/slots').send(slotMoFrKW2Data2);
        const respSlot8 = await request(app).post('/api/slots').send(slotSaSoKW2Data2);

        const respSlot9 = await request(app).post('/api/slots').send(slotMoFrKW1Data3);
        const respSlot10 = await request(app).post('/api/slots').send(slotSaSoKW1Data3);

        const respSlot11 = await request(app).post('/api/slots').send(slotMoFrKW2Data3);
        const respSlot12 = await request(app).post('/api/slots').send(slotSaSoKW2Data3);

        const respSlot13 = await request(app).post('/api/slots').send(slotMoFrKW3Data1);
        const respSlot14 = await request(app).post('/api/slots').send(slotSaSoKW3Data1);
        const respSlot15 = await request(app).post('/api/slots').send(slotMoFrKW3Data2);
        const respSlot16 = await request(app).post('/api/slots').send(slotSaSoKW3Data2);
        const respSlot17 = await request(app).post('/api/slots').send(slotMoFrKW3Data3);
        const respSlot18 = await request(app).post('/api/slots').send(slotSaSoKW3Data3);

        expect(respSlot1.status).toBe(201); 
        expect(respSlot2.status).toBe(201);
        expect(respSlot3.status).toBe(201); 
        expect(respSlot4.status).toBe(201);
        expect(respSlot5.status).toBe(201); 
        expect(respSlot6.status).toBe(201);
        expect(respSlot7.status).toBe(201); 
        expect(respSlot8.status).toBe(201);
        expect(respSlot9.status).toBe(201); 
        expect(respSlot10.status).toBe(201);
        expect(respSlot11.status).toBe(201); 
        expect(respSlot12.status).toBe(201);
        expect(respSlot13.status).toBe(201); 
        expect(respSlot14.status).toBe(201);
        expect(respSlot15.status).toBe(201); 
        expect(respSlot16.status).toBe(201);
        expect(respSlot17.status).toBe(201); 
        expect(respSlot18.status).toBe(201);

        const slotMoFrKW1_1 = respSlot1.body.data;
        const slotSaSoKW1_1 = respSlot2.body.data;
        const slotMoFrKW2_1 = respSlot3.body.data;
        const slotSaSoKW2_1 = respSlot4.body.data;
        const slotMoFrKW1_2 = respSlot5.body.data;
        const slotSaSoKW1_2 = respSlot6.body.data;
        const slotMoFrKW2_2 = respSlot7.body.data;
        const slotSaSoKW2_2 = respSlot8.body.data;
        const slotMoFrKW1_3 = respSlot9.body.data;
        const slotSaSoKW1_3 = respSlot10.body.data;
        const slotMoFrKW2_3 = respSlot11.body.data;
        const slotSaSoKW2_3 = respSlot12.body.data;

        const slotMoFrKW3_1 = respSlot13.body.data;
        const slotSaSoKW3_1 = respSlot14.body.data;
        const slotMoFrKW3_2 = respSlot15.body.data;
        const slotSaSoKW3_2 = respSlot16.body.data;
        const slotMoFrKW3_3 = respSlot17.body.data;
        const slotSaSoKW3_3 = respSlot18.body.data;

        // IDs der automatisch erstellten/gefundenen Kapazitätstöpfe holen
        const ktMoFrKW1_Id1 = slotMoFrKW1_1.VerweisAufTopf;
        const ktSaSoKW1_Id1 = slotSaSoKW1_1.VerweisAufTopf;
        const ktMoFrKW2_Id1 = slotMoFrKW2_1.VerweisAufTopf;
        const ktSaSoKW2_Id1 = slotSaSoKW2_1.VerweisAufTopf;
        const ktMoFrKW1_Id2 = slotMoFrKW1_2.VerweisAufTopf;
        const ktSaSoKW1_Id2 = slotSaSoKW1_2.VerweisAufTopf;
        const ktMoFrKW2_Id2 = slotMoFrKW2_2.VerweisAufTopf;
        const ktSaSoKW2_Id2 = slotSaSoKW2_2.VerweisAufTopf;
        const ktMoFrKW1_Id3 = slotMoFrKW1_3.VerweisAufTopf;
        const ktSaSoKW1_Id3 = slotSaSoKW1_3.VerweisAufTopf;
        const ktMoFrKW2_Id3 = slotMoFrKW2_3.VerweisAufTopf;
        const ktSaSoKW2_Id3 = slotSaSoKW2_3.VerweisAufTopf;

        const ktMoFrKW3_Id1 = slotMoFrKW3_1.VerweisAufTopf;
        const ktSaSoKW3_Id1 = slotSaSoKW3_1.VerweisAufTopf;
        const ktMoFrKW3_Id2 = slotMoFrKW3_2.VerweisAufTopf;
        const ktSaSoKW3_Id2 = slotSaSoKW3_2.VerweisAufTopf;
        const ktMoFrKW3_Id3 = slotMoFrKW3_3.VerweisAufTopf;
        const ktSaSoKW3_Id3 = slotSaSoKW3_3.VerweisAufTopf;

        expect(ktMoFrKW1_Id1).toBeDefined(); 
        expect(ktSaSoKW1_Id1).toBeDefined();
        expect(ktMoFrKW2_Id1).toBeDefined(); 
        expect(ktSaSoKW2_Id1).toBeDefined();
        expect(ktMoFrKW1_Id2).toBeDefined(); 
        expect(ktSaSoKW1_Id2).toBeDefined();
        expect(ktMoFrKW2_Id2).toBeDefined(); 
        expect(ktSaSoKW2_Id2).toBeDefined();
        expect(ktMoFrKW1_Id3).toBeDefined(); 
        expect(ktSaSoKW1_Id3).toBeDefined();
        expect(ktMoFrKW2_Id3).toBeDefined(); 
        expect(ktSaSoKW2_Id3).toBeDefined();
        expect(ktMoFrKW3_Id1).toBeDefined(); 
        expect(ktSaSoKW3_Id1).toBeDefined();
        expect(ktMoFrKW3_Id2).toBeDefined(); 
        expect(ktSaSoKW3_Id2).toBeDefined();
        expect(ktMoFrKW3_Id3).toBeDefined(); 
        expect(ktSaSoKW3_Id3).toBeDefined();
        // Sicherstellen, dass es vier unterschiedliche Töpfe sind (aufgrund KW und Verkehrstag)
        const topfIds = new Set([ktMoFrKW1_Id1, ktSaSoKW1_Id1, ktMoFrKW2_Id1, ktSaSoKW2_Id1, ktMoFrKW3_Id1, ktSaSoKW3_Id1,
                                 ktMoFrKW1_Id2, ktSaSoKW1_Id2, ktMoFrKW2_Id2, ktSaSoKW2_Id2, ktMoFrKW3_Id2, ktSaSoKW3_Id2,
                                 ktMoFrKW1_Id3, ktSaSoKW1_Id3, ktMoFrKW2_Id3, ktSaSoKW2_Id3, ktMoFrKW3_Id3, ktSaSoKW3_Id3,
                                ]);
        expect(topfIds.size).toBe(18);


        // ----- 2. Anfrage erstellen -----
        const anfrageData = {
            EVU: "DB Fernverkehr AG",
            ListeGewuenschterSlotAbschnitte: [
                {
                von: "StadtA", bis: "StadtB",
                Abfahrtszeit: { stunde: 22, minute: 30 }, Ankunftszeit: { stunde: 23, minute: 30 }
                },
                {
                von: "StadtB", bis: "StadtC",
                Abfahrtszeit: { stunde: 23, minute: 45 }, Ankunftszeit: { stunde: 0, minute: 55 }
                },
                {
                von: "StadtC", bis: "StadtD",
                Abfahrtszeit: { stunde: 1, minute: 5 }, Ankunftszeit: { stunde: 2, minute: 15 }
                },
            ],
            Verkehrsart: "SPFV",
            Verkehrstag: "Sa+So",
            Zeitraum: {
                start: "2024-12-30", // Mo, 30.12.2024 (Start KW1)
                ende: "2025-01-12" // So, 12.01.2025 (Ende KW2)
            },
            Email: "test@example.com",
            Status: "validiert", // Wir erstellen sie direkt als 'validiert' für diesen Test
            //Entgelt: 6300
        };
        const anfrageData2 = {
            EVU: "DB Fernverkehr AG",
            ListeGewuenschterSlotAbschnitte: [
                {
                von: "StadtA", bis: "StadtB",
                Abfahrtszeit: { stunde: 22, minute: 30 }, Ankunftszeit: { stunde: 23, minute: 30 }
                },
                {
                von: "StadtB", bis: "StadtC",
                Abfahrtszeit: { stunde: 0, minute: 5 }, Ankunftszeit: { stunde: 1, minute: 15 }
                },
                {
                von: "StadtC", bis: "StadtD",
                Abfahrtszeit: { stunde: 1, minute: 25 }, Ankunftszeit: { stunde: 2, minute: 25 }
                },
            ],
            Verkehrsart: "SPFV",
            Verkehrstag: "Sa+So",
            Zeitraum: {
                start: "2024-12-30", // Mo, 30.12.2024 (Start KW1)
                ende: "2025-01-12" // So, 12.01.2025 (Ende KW2)
            },
            Email: "test@example.com",
            Status: "validiert", // Wir erstellen sie direkt als 'validiert' für diesen Test
            //Entgelt: 6300
        };
        // Man wird eine Anfrage mit POST /api/anfragen erstellt
        // und dann den Status auf 'validiert' setzen, falls die Erstellung nicht direkt 'validiert' erlaubt.
        // Hier nehmen wir an, sie kann als 'validiert' erstellt werden oder wir setzen den Status manuell in der DB.
        const anfrageErstelltResponse = await request(app).post('/api/anfragen').send({...anfrageData, Zugnummer: "100"});
        expect(anfrageErstelltResponse.status).toBe(201); // Annahme: POST /api/anfragen gibt 201 bei Erfolg
        let anfrageErstellt = anfrageErstelltResponse.body.data;
        anfrageErstellt = await Anfrage.findById(anfrageErstellt._id);
        //console.log(anfrageErstellt.ListeGewuenschterSlotAbschnitte);
        anfrageErstellt.Status = 'validiert';
        await anfrageErstellt.save();
        expect(anfrageErstellt.Status).toBe("validiert");

        const anfrageErstelltResponse2 = await request(app).post('/api/anfragen').send({...anfrageData2, Zugnummer: "200"});
        expect(anfrageErstelltResponse2.status).toBe(201); // Annahme: POST /api/anfragen gibt 201 bei Erfolg
        let anfrageErstellt2 = anfrageErstelltResponse2.body.data;
        anfrageErstellt2 = await Anfrage.findById(anfrageErstellt2._id);
        //console.log(anfrageErstellt2.ListeGewuenschterSlotAbschnitte);
        //console.log(anfrageErstellt2);
        anfrageErstellt2.Status = 'validiert';
        await anfrageErstellt2.save();
        expect(anfrageErstellt2.Status).toBe("validiert");

        const anfrageErstelltResponse3 = await request(app).post('/api/anfragen').send({...anfrageData, Zugnummer: "300", Verkehrstag: "Mo-Fr"});
        expect(anfrageErstelltResponse3.status).toBe(201); // Annahme: POST /api/anfragen gibt 201 bei Erfolg
        let anfrageErstellt3 = anfrageErstelltResponse3.body.data;
        anfrageErstellt3 = await Anfrage.findById(anfrageErstellt3._id);
        //console.log(anfrageErstellt3);
        anfrageErstellt3.Status = 'validiert';
        await anfrageErstellt3.save();
        expect(anfrageErstellt3.Status).toBe("validiert");


        // ----- 3. Aktion: Zuordnungsprozess anstoßen -----
        const zuordnenResponse = await request(app)
            .post(`/api/anfragen/zuordnen/alle-validierten`)
            .send();

        //console.log(zuordnenResponse);
        expect(zuordnenResponse.status).toBe(200);
        const summary = zuordnenResponse.body.summary;
        expect(summary.total).toBe(3);
        expect(summary.success).toBe(3);
        expect(summary.failed).toBe(0);

        anfrageErstellt = await Anfrage.findById(anfrageErstellt._id);
        anfrageErstellt2 = await Anfrage.findById(anfrageErstellt2._id);
        anfrageErstellt3 = await Anfrage.findById(anfrageErstellt3._id);

        // ----- 4. Überprüfung -----
        // 4.1a Zugewiesene Slots in der Anfrage 1
        expect(anfrageErstellt.ZugewieseneSlots).toHaveLength(8);
        const zugewieseneSlotIdsInAnfrage = anfrageErstellt.ZugewieseneSlots.map(obj => obj.slot.toString());
        
        expect(zugewieseneSlotIdsInAnfrage).toContain(slotSaSoKW1_1._id.toString());        
        expect(zugewieseneSlotIdsInAnfrage).toContain(slotSaSoKW2_1._id.toString());        
        expect(zugewieseneSlotIdsInAnfrage).toContain(slotSaSoKW1_2._id.toString());        
        expect(zugewieseneSlotIdsInAnfrage).toContain(slotSaSoKW2_2._id.toString());
        expect(zugewieseneSlotIdsInAnfrage).toContain(slotSaSoKW1_3._id.toString());        
        expect(zugewieseneSlotIdsInAnfrage).toContain(slotSaSoKW2_3._id.toString());
        expect(zugewieseneSlotIdsInAnfrage).toContain(slotMoFrKW2_3._id.toString()); // durch den Überhang am So auf Mo im Abschnitt 3
        expect(zugewieseneSlotIdsInAnfrage).toContain(slotMoFrKW3_3._id.toString()); // durch den Überhang am So auf Mo im Abschnitt 3
        const zugewieseneSlotStatusInAnfrage = anfrageErstellt.ZugewieseneSlots.map(obj => obj.statusEinzelzuweisung);
        expect(new Set(zugewieseneSlotStatusInAnfrage).size).toBe(1);
        expect(zugewieseneSlotStatusInAnfrage[0]).toBe('initial_in_konfliktpruefung_topf');

        // 4.1b Zugewiesene Slots in der Anfrage 2
        expect(anfrageErstellt2.ZugewieseneSlots).toHaveLength(8);
        const zugewieseneSlotIdsInAnfrage2 = anfrageErstellt2.ZugewieseneSlots.map(obj => obj.slot.toString());
        
        expect(zugewieseneSlotIdsInAnfrage2).toContain(slotSaSoKW1_1._id.toString());        
        expect(zugewieseneSlotIdsInAnfrage2).toContain(slotSaSoKW2_1._id.toString());        
        expect(zugewieseneSlotIdsInAnfrage2).toContain(slotSaSoKW1_2._id.toString()); // Trotz Tageswechsel kein Überhang in Mo-Fr Topf       
        expect(zugewieseneSlotIdsInAnfrage2).toContain(slotSaSoKW2_2._id.toString()); // Trotz Tageswechsel kein Überhang in Mo-Fr Topf
        expect(zugewieseneSlotIdsInAnfrage2).toContain(slotSaSoKW1_3._id.toString());        
        expect(zugewieseneSlotIdsInAnfrage2).toContain(slotSaSoKW2_3._id.toString());
        expect(zugewieseneSlotIdsInAnfrage2).toContain(slotMoFrKW2_3._id.toString()); // durch den Überhang am So auf Mo im Abschnitt 3
        expect(zugewieseneSlotIdsInAnfrage2).toContain(slotMoFrKW3_3._id.toString()); // durch den Überhang am So auf Mo im Abschnitt 3
        const zugewieseneSlotStatusInAnfrage2 = anfrageErstellt2.ZugewieseneSlots.map(obj => obj.statusEinzelzuweisung);
        expect(new Set(zugewieseneSlotStatusInAnfrage2).size).toBe(1);
        expect(zugewieseneSlotStatusInAnfrage2[0]).toBe('initial_in_konfliktpruefung_topf');

        // 4.1c Zugewiesene Slots in der Anfrage 3
        expect(anfrageErstellt3.ZugewieseneSlots).toHaveLength(8);
        const zugewieseneSlotIdsInAnfrage3 = anfrageErstellt3.ZugewieseneSlots.map(obj => obj.slot.toString());

        expect(zugewieseneSlotIdsInAnfrage3).toContain(slotMoFrKW1_1._id.toString());        
        expect(zugewieseneSlotIdsInAnfrage3).toContain(slotMoFrKW2_1._id.toString());        
        expect(zugewieseneSlotIdsInAnfrage3).toContain(slotMoFrKW1_2._id.toString());        
        expect(zugewieseneSlotIdsInAnfrage3).toContain(slotMoFrKW2_2._id.toString());
        expect(zugewieseneSlotIdsInAnfrage3).toContain(slotMoFrKW1_3._id.toString());        
        expect(zugewieseneSlotIdsInAnfrage3).toContain(slotMoFrKW2_3._id.toString());
        expect(zugewieseneSlotIdsInAnfrage3).toContain(slotSaSoKW1_3._id.toString()); // durch den Überhang am Fr auf Sa in Abschnitt 3     
        expect(zugewieseneSlotIdsInAnfrage3).toContain(slotSaSoKW2_3._id.toString()); // durch den Überhang am Fr auf Sa in Abschnitt 3 
        const zugewieseneSlotStatusInAnfrage3 = anfrageErstellt3.ZugewieseneSlots.map(obj => obj.statusEinzelzuweisung);
        expect(new Set(zugewieseneSlotStatusInAnfrage3).size).toBe(1);
        expect(zugewieseneSlotStatusInAnfrage3[0]).toBe('initial_in_konfliktpruefung_topf');

        // 4.2 Kapazitätstopf-Listen
        const ktMoFrKW1_final1 = await Kapazitaetstopf.findById(ktMoFrKW1_Id1);
        const ktSaSoKW1_final1 = await Kapazitaetstopf.findById(ktSaSoKW1_Id1);
        const ktMoFrKW2_final1 = await Kapazitaetstopf.findById(ktMoFrKW2_Id1);
        const ktSaSoKW2_final1 = await Kapazitaetstopf.findById(ktSaSoKW2_Id1);
        const ktMoFrKW1_final2 = await Kapazitaetstopf.findById(ktMoFrKW1_Id2);
        const ktSaSoKW1_final2 = await Kapazitaetstopf.findById(ktSaSoKW1_Id2);
        const ktMoFrKW2_final2 = await Kapazitaetstopf.findById(ktMoFrKW2_Id2);
        const ktSaSoKW2_final2 = await Kapazitaetstopf.findById(ktSaSoKW2_Id2);
        const ktMoFrKW1_final3 = await Kapazitaetstopf.findById(ktMoFrKW1_Id3);
        const ktSaSoKW1_final3 = await Kapazitaetstopf.findById(ktSaSoKW1_Id3);
        const ktMoFrKW2_final3 = await Kapazitaetstopf.findById(ktMoFrKW2_Id3);
        const ktSaSoKW2_final3 = await Kapazitaetstopf.findById(ktSaSoKW2_Id3);  
        
        const ktMoFrKW3_final1 = await Kapazitaetstopf.findById(ktMoFrKW3_Id1);
        const ktSaSoKW3_final1 = await Kapazitaetstopf.findById(ktSaSoKW3_Id1);
        const ktMoFrKW3_final2 = await Kapazitaetstopf.findById(ktMoFrKW3_Id2);
        const ktSaSoKW3_final2 = await Kapazitaetstopf.findById(ktSaSoKW3_Id2);
        const ktMoFrKW3_final3 = await Kapazitaetstopf.findById(ktMoFrKW3_Id3);
        const ktSaSoKW3_final3 = await Kapazitaetstopf.findById(ktSaSoKW3_Id3);

        
        expect(ktSaSoKW1_final1.ListeDerAnfragen.map(id => id.toString())).toContain(anfrageErstellt._id.toString());       
        expect(ktSaSoKW2_final1.ListeDerAnfragen.map(id => id.toString())).toContain(anfrageErstellt._id.toString());
        expect(ktSaSoKW1_final2.ListeDerAnfragen.map(id => id.toString())).toContain(anfrageErstellt._id.toString());
        expect(ktSaSoKW2_final2.ListeDerAnfragen.map(id => id.toString())).toContain(anfrageErstellt._id.toString());
        expect(ktSaSoKW1_final3.ListeDerAnfragen.map(id => id.toString())).toContain(anfrageErstellt._id.toString());
        expect(ktSaSoKW2_final3.ListeDerAnfragen.map(id => id.toString())).toContain(anfrageErstellt._id.toString());
        expect(ktMoFrKW2_final3.ListeDerAnfragen.map(id => id.toString())).toContain(anfrageErstellt._id.toString());
        expect(ktMoFrKW3_final3.ListeDerAnfragen.map(id => id.toString())).toContain(anfrageErstellt._id.toString());

        expect(ktSaSoKW1_final1.ListeDerAnfragen.map(id => id.toString())).toContain(anfrageErstellt2._id.toString());       
        expect(ktSaSoKW2_final1.ListeDerAnfragen.map(id => id.toString())).toContain(anfrageErstellt2._id.toString());
        expect(ktSaSoKW1_final2.ListeDerAnfragen.map(id => id.toString())).toContain(anfrageErstellt2._id.toString());
        expect(ktSaSoKW2_final2.ListeDerAnfragen.map(id => id.toString())).toContain(anfrageErstellt2._id.toString());
        expect(ktSaSoKW1_final3.ListeDerAnfragen.map(id => id.toString())).toContain(anfrageErstellt2._id.toString());
        expect(ktSaSoKW2_final3.ListeDerAnfragen.map(id => id.toString())).toContain(anfrageErstellt2._id.toString());
        expect(ktMoFrKW2_final3.ListeDerAnfragen.map(id => id.toString())).toContain(anfrageErstellt2._id.toString());
        expect(ktMoFrKW3_final3.ListeDerAnfragen.map(id => id.toString())).toContain(anfrageErstellt2._id.toString());

        expect(ktMoFrKW1_final1.ListeDerAnfragen.map(id => id.toString())).toContain(anfrageErstellt3._id.toString());       
        expect(ktMoFrKW2_final1.ListeDerAnfragen.map(id => id.toString())).toContain(anfrageErstellt3._id.toString());
        expect(ktMoFrKW1_final2.ListeDerAnfragen.map(id => id.toString())).toContain(anfrageErstellt3._id.toString());
        expect(ktMoFrKW2_final2.ListeDerAnfragen.map(id => id.toString())).toContain(anfrageErstellt3._id.toString());
        expect(ktMoFrKW1_final3.ListeDerAnfragen.map(id => id.toString())).toContain(anfrageErstellt3._id.toString());
        expect(ktMoFrKW2_final3.ListeDerAnfragen.map(id => id.toString())).toContain(anfrageErstellt3._id.toString());
        expect(ktSaSoKW1_final3.ListeDerAnfragen.map(id => id.toString())).toContain(anfrageErstellt3._id.toString());
        expect(ktSaSoKW2_final3.ListeDerAnfragen.map(id => id.toString())).toContain(anfrageErstellt3._id.toString());

        expect(ktMoFrKW3_final1.ListeDerAnfragen.length).toBe(0);
        expect(ktSaSoKW3_final1.ListeDerAnfragen.length).toBe(0);
        expect(ktMoFrKW3_final2.ListeDerAnfragen.length).toBe(0);
        expect(ktSaSoKW3_final2.ListeDerAnfragen.length).toBe(0);
        expect(ktSaSoKW3_final3.ListeDerAnfragen.length).toBe(0);

        

        // 4.3 Slots zugewiesene Anfragen
        const slot1_final1 = await Slot.findById(slotSaSoKW1_1._id);
        const slot2_final1 = await Slot.findById(slotSaSoKW2_1._id);
        const slot3_final1 = await Slot.findById(slotSaSoKW1_2._id);
        const slot4_final1 = await Slot.findById(slotSaSoKW2_2._id);
        const slot5_final1 = await Slot.findById(slotSaSoKW1_3._id);
        const slot6_final1 = await Slot.findById(slotSaSoKW2_3._id);
        const slot7_final1 = await Slot.findById(slotMoFrKW2_3._id);
        const slot8_final1 = await Slot.findById(slotMoFrKW3_3._id);

        const slot1_final3 = await Slot.findById(slotMoFrKW1_1._id);
        const slot2_final3 = await Slot.findById(slotMoFrKW2_1._id);
        const slot3_final3 = await Slot.findById(slotMoFrKW1_2._id);
        const slot4_final3 = await Slot.findById(slotMoFrKW2_2._id);
        const slot5_final3 = await Slot.findById(slotMoFrKW1_3._id);
        const slot6_final3 = await Slot.findById(slotMoFrKW2_3._id);
        const slot7_final3 = await Slot.findById(slotSaSoKW1_3._id);
        const slot8_final3 = await Slot.findById(slotSaSoKW2_3._id);

        expect(slot1_final1.zugewieseneAnfragen.map(id => id.toString())).toContain(anfrageErstellt._id.toString());
        expect(slot2_final1.zugewieseneAnfragen.map(id => id.toString())).toContain(anfrageErstellt._id.toString());
        expect(slot3_final1.zugewieseneAnfragen.map(id => id.toString())).toContain(anfrageErstellt._id.toString());
        expect(slot4_final1.zugewieseneAnfragen.map(id => id.toString())).toContain(anfrageErstellt._id.toString());
        expect(slot5_final1.zugewieseneAnfragen.map(id => id.toString())).toContain(anfrageErstellt._id.toString());
        expect(slot6_final1.zugewieseneAnfragen.map(id => id.toString())).toContain(anfrageErstellt._id.toString());
        expect(slot7_final1.zugewieseneAnfragen.map(id => id.toString())).toContain(anfrageErstellt._id.toString());
        expect(slot8_final1.zugewieseneAnfragen.map(id => id.toString())).toContain(anfrageErstellt._id.toString());

        expect(slot1_final1.zugewieseneAnfragen.map(id => id.toString())).toContain(anfrageErstellt2._id.toString());
        expect(slot2_final1.zugewieseneAnfragen.map(id => id.toString())).toContain(anfrageErstellt2._id.toString());
        expect(slot3_final1.zugewieseneAnfragen.map(id => id.toString())).toContain(anfrageErstellt2._id.toString());
        expect(slot4_final1.zugewieseneAnfragen.map(id => id.toString())).toContain(anfrageErstellt2._id.toString());
        expect(slot5_final1.zugewieseneAnfragen.map(id => id.toString())).toContain(anfrageErstellt2._id.toString());
        expect(slot6_final1.zugewieseneAnfragen.map(id => id.toString())).toContain(anfrageErstellt2._id.toString());
        expect(slot7_final1.zugewieseneAnfragen.map(id => id.toString())).toContain(anfrageErstellt2._id.toString());
        expect(slot8_final1.zugewieseneAnfragen.map(id => id.toString())).toContain(anfrageErstellt2._id.toString());

        expect(slot1_final3.zugewieseneAnfragen.map(id => id.toString())).toContain(anfrageErstellt3._id.toString());
        expect(slot2_final3.zugewieseneAnfragen.map(id => id.toString())).toContain(anfrageErstellt3._id.toString());
        expect(slot3_final3.zugewieseneAnfragen.map(id => id.toString())).toContain(anfrageErstellt3._id.toString());
        expect(slot4_final3.zugewieseneAnfragen.map(id => id.toString())).toContain(anfrageErstellt3._id.toString());
        expect(slot5_final3.zugewieseneAnfragen.map(id => id.toString())).toContain(anfrageErstellt3._id.toString());
        expect(slot6_final3.zugewieseneAnfragen.map(id => id.toString())).toContain(anfrageErstellt3._id.toString());
        expect(slot7_final3.zugewieseneAnfragen.map(id => id.toString())).toContain(anfrageErstellt3._id.toString());
        expect(slot8_final3.zugewieseneAnfragen.map(id => id.toString())).toContain(anfrageErstellt3._id.toString());
        

        

        // WICHTIG: Teste auch das berechnete Entgelt
        // Annahme: Alle genutzten Slot-Muster haben Grundentgelt 150.
        // Die Anfrage 1 + 2 läuft über 2 volle KWs "Sa+So", also 4 Tage.
        // Jeder Abschnitt der Anfrage wird an diesen 4 Tagen befahren.
        // Pro Tag kostet ein Abschnitt 150€. Summe pro Durchlauf = 450€ (für die 3 Abschnitte).
        // Gesamtentgelt = 4 Tage * 450€/Tag = 1800€.
        // Die Anfrage 3 läuft über 2 volle KWs "Mo-Fr", also 10 Tage.
        // Jeder Abschnitt der Anfrage wird an diesen 10 Tagen befahren.
        // Pro Tag kostet ein Abschnitt 150€. Summe pro Durchlauf = 450€ (für die 3 Abschnitte).
        // Gesamtentgelt = 10 Tage * 450€/Tag = 4500€.
        const erwartetesEntgelt = 4 * (450); // 4 Tage * (Grundentgelt SlotTyp)
        const erwartetesEntgelt2 = 10 * (450); // 10 Tage * (Grundentgelt SlotTyp)
        expect(anfrageErstellt.Entgelt).toBe(erwartetesEntgelt);
        expect(anfrageErstellt2.Entgelt).toBe(erwartetesEntgelt);
        expect(anfrageErstellt3.Entgelt).toBe(erwartetesEntgelt2);
    });
});

describe('Entgeltberechnung im Zuordnungsprozess', () => {

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

    it('E1: Sollte das Entgelt für eine einfache Anfrage mit einem Slot-Abschnitt korrekt berechnen', async () => {
        // 1. Vorbereitung: Slot erstellen
        const slotData_E1 = {
            slotTyp: 'TAG',
            von: "StartE1", bis: "EndeE1", Abschnitt: "Einfach",
            Abfahrt: { stunde: 10, minute: 0 }, Ankunft: { stunde: 11, minute: 0 },
            Verkehrstag: "Mo-Fr", Kalenderwoche: 10, // Globale relative KW 10
            Verkehrsart: "SPNV", Grundentgelt: 100
        };
        const slotResponse = await request(app).post('/api/slots').send(slotData_E1);
        expect(slotResponse.status).toBe(201);
        const s_E1 = slotResponse.body.data;

        // 2. Anfrage-Daten definieren und Anfrage erstellen
        // Zeitraum: Montag bis Mittwoch in der globalen relativen KW 10
        // KW10 von 2025: Mo, 03.03.2025 - So, 09.03.2025
        const zeitraum_E1 = { start: "2025-03-03", ende: "2025-03-05" }; // Mo, Di, Mi
        const anfrageVerkehrstag_E1 = "Mo-Fr";
        const erwarteteBetriebstage_E1 = calculateTotalOperatingDaysForAnfrage(zeitraum_E1, anfrageVerkehrstag_E1);
        expect(erwarteteBetriebstage_E1).toBe(3); // Sicherstellen, dass unsere Hilfsfunktion korrekt zählt

        const anfrageData_E1 = {
            Zugnummer: "E1_Zug", EVU: "EVU_E",
            ListeGewuenschterSlotAbschnitte: [{
                von: "StartE1", bis: "EndeE1",
                Abfahrtszeit: { stunde: 10, minute: 0 }, Ankunftszeit: { stunde: 11, minute: 0 }
            }],
            Verkehrsart: "SPNV",
            Verkehrstag: anfrageVerkehrstag_E1,
            Zeitraum: zeitraum_E1,
            Email: "e1@test.com",
            Status: "validiert"
        };
        const anfrageErstelltResponse = await request(app).post('/api/anfragen').send(anfrageData_E1);
        expect(anfrageErstelltResponse.status).toBe(201);
        let anfrage_E1 = anfrageErstelltResponse.body.data;
        anfrageErstellt = await Anfrage.findById(anfrage_E1._id);
        //console.log(anfrageErstellt);
        anfrageErstellt.Status = 'validiert';
        await anfrageErstellt.save();
        expect(anfrageErstellt.Status).toBe("validiert");

        // 3. Aktion: Zuordnungsprozess anstoßen
        const zuordnenResponse = await request(app)
            .post(`/api/anfragen/${anfrage_E1._id}/zuordnen`)
            .send();
        
        // 4. Überprüfung
        expect(zuordnenResponse.status).toBe(200);
        const aktualisierteAnfrage_E1 = zuordnenResponse.body.data;

        expect(aktualisierteAnfrage_E1.ZugewieseneSlots).toHaveLength(1);
        expect(aktualisierteAnfrage_E1.ZugewieseneSlots[0].slot.toString()).toBe(s_E1._id.toString());
        expect(aktualisierteAnfrage_E1.ZugewieseneSlots[0].statusEinzelzuweisung).toBe('initial_in_konfliktpruefung_topf');
        
        const erwartetesEntgelt_E1 = erwarteteBetriebstage_E1 * s_E1.Grundentgelt; // 3 * 100 = 300
        expect(aktualisierteAnfrage_E1.Entgelt).toBe(erwartetesEntgelt_E1);

        // Direkte DB-Prüfung
        const anfrageDB = await Anfrage.findById(anfrage_E1._id);
        expect(anfrageDB.Entgelt).toBe(erwartetesEntgelt_E1);
    });

    it('E2: Sollte das Entgelt für eine tägliche Anfrage mit 2 Abschnitten über 2 KWs korrekt berechnen', async () => {
        // ----- 1. Vorbereitung: Slot-Muster erstellen -----
        const grundentgelt_AB = 100;
        const grundentgelt_BC = 50;
        const gemeinsamerAbschnittParams = { Verkehrsart: "SPFV", AbfahrtStunde: 8, AnkunftStunde: 9 };

        const slotDefinitionen = [
            // Abschnitt A->B
            { von: "A", bis: "B", Abschnitt: "AB_Strecke", Kalenderwoche: 1, Verkehrstag: "Mo-Fr", Grundentgelt: grundentgelt_AB, ...gemeinsamerAbschnittParams },
            { von: "A", bis: "B", Abschnitt: "AB_Strecke", Kalenderwoche: 1, Verkehrstag: "Sa+So", Grundentgelt: grundentgelt_AB, ...gemeinsamerAbschnittParams },
            { von: "A", bis: "B", Abschnitt: "AB_Strecke", Kalenderwoche: 2, Verkehrstag: "Mo-Fr", Grundentgelt: grundentgelt_AB, ...gemeinsamerAbschnittParams },
            { von: "A", bis: "B", Abschnitt: "AB_Strecke", Kalenderwoche: 2, Verkehrstag: "Sa+So", Grundentgelt: grundentgelt_AB, ...gemeinsamerAbschnittParams },
            // Abschnitt B->C
            { von: "B", bis: "C", Abschnitt: "BC_Strecke", Kalenderwoche: 1, Verkehrstag: "Mo-Fr", Grundentgelt: grundentgelt_BC, ...gemeinsamerAbschnittParams },
            { von: "B", bis: "C", Abschnitt: "BC_Strecke", Kalenderwoche: 1, Verkehrstag: "Sa+So", Grundentgelt: grundentgelt_BC, ...gemeinsamerAbschnittParams },
            { von: "B", bis: "C", Abschnitt: "BC_Strecke", Kalenderwoche: 2, Verkehrstag: "Mo-Fr", Grundentgelt: grundentgelt_BC, ...gemeinsamerAbschnittParams },
            { von: "B", bis: "C", Abschnitt: "BC_Strecke", Kalenderwoche: 2, Verkehrstag: "Sa+So", Grundentgelt: grundentgelt_BC, ...gemeinsamerAbschnittParams },
        ];

        const erstellteSlotObjekte = [];
        for (const def of slotDefinitionen) {
            const slotData = {
                slotTyp: 'TAG',
                von: def.von, bis: def.bis, Abschnitt: def.Abschnitt,
                Abfahrt: { stunde: def.AbfahrtStunde, minute: 0 }, Ankunft: { stunde: def.AnkunftStunde, minute: 0 },
                Verkehrstag: def.Verkehrstag, Kalenderwoche: def.Kalenderwoche, Verkehrsart: def.Verkehrsart, Grundentgelt: def.Grundentgelt
            };
            const response = await request(app).post('/api/slots').send(slotData);
            expect(response.status).toBe(201);
            erstellteSlotObjekte.push(response.body.data);
        }
        expect(erstellteSlotObjekte).toHaveLength(8);

        // ----- 2. Anfrage-Daten definieren und Anfrage erstellen -----
        const zeitraum_E2 = {
            start: "2024-12-30", // Mo, 30.12.2024 (Start KW1)
            ende: "2025-01-12" // So, 12.01.2025 (Ende KW2)
        };
        const anfrageVerkehrstag_E2 = "täglich";
        const erwarteteBetriebstage_E2 = calculateTotalOperatingDaysForAnfrage(zeitraum_E2, anfrageVerkehrstag_E2);
        expect(erwarteteBetriebstage_E2).toBe(14); // 2 volle Wochen * 7 Tage/Woche

        const anfrageData_E2 = {
            Zugnummer: "E2_MultiSegment", EVU: "EVU_MS",
            ListeGewuenschterSlotAbschnitte: [
                { von: "A", bis: "B", Abfahrtszeit: { stunde: gemeinsamerAbschnittParams.AbfahrtStunde, minute: 0 }, Ankunftszeit: { stunde: gemeinsamerAbschnittParams.AnkunftStunde, minute: 0 } },
                { von: "B", bis: "C", Abfahrtszeit: { stunde: gemeinsamerAbschnittParams.AbfahrtStunde, minute: 0 }, Ankunftszeit: { stunde: gemeinsamerAbschnittParams.AnkunftStunde, minute: 0 } }
            ],
            Verkehrsart: gemeinsamerAbschnittParams.Verkehrsart,
            Verkehrstag: anfrageVerkehrstag_E2,
            Zeitraum: zeitraum_E2,
            Email: "e2@test.com",
            Status: "validiert"
        };
        const anfrageErstelltResponse = await request(app).post('/api/anfragen').send(anfrageData_E2);
        expect(anfrageErstelltResponse.status).toBe(201);
        const anfrage_E2 = anfrageErstelltResponse.body.data;
        anfrageErstellt = await Anfrage.findById(anfrage_E2._id);
        //console.log(anfrageErstellt);
        anfrageErstellt.Status = 'validiert';
        await anfrageErstellt.save();
        expect(anfrageErstellt.Status).toBe("validiert");

        // ----- 3. Aktion: Zuordnungsprozess anstoßen -----
        const zuordnenResponse = await request(app)
            .post(`/api/anfragen/${anfrage_E2._id}/zuordnen`)
            .send();
        
        // ----- 4. Überprüfung -----
        expect(zuordnenResponse.status).toBe(200);
        const aktualisierteAnfrage_E2 = zuordnenResponse.body.data;

        // 4.1 Entgelt
        const summeGrundentgelteProTag = grundentgelt_AB + grundentgelt_BC; // 100 + 50 = 150
        const erwartetesGesamtentgelt_E2 = erwarteteBetriebstage_E2 * summeGrundentgelteProTag; // 14 * 150 = 2100
        expect(aktualisierteAnfrage_E2.Entgelt).toBe(erwartetesGesamtentgelt_E2);

        // 4.2 Zugewiesene Slots
        expect(aktualisierteAnfrage_E2.ZugewieseneSlots).toHaveLength(8);
        // Stelle sicher, dass alle erstellten Slot-IDs in den ZugewiesenenSlots der Anfrage sind
        // und den korrekten Initialstatus haben
        for (const erstellterSlot of erstellteSlotObjekte) {
            const zuweisungEintrag = aktualisierteAnfrage_E2.ZugewieseneSlots.find(
                zs => zs.slot.toString() === erstellterSlot._id.toString()
            );
            expect(zuweisungEintrag).toBeDefined();
            expect(zuweisungEintrag.statusEinzelzuweisung).toBe('initial_in_konfliktpruefung_topf');
        }

        // 4.3 (Optional/Sekundär) Überprüfung der Kapazitätstöpfe und Slot-Verknüpfungen
        const zugewieseneTopfIdsInAnfrage = new Set();
        for (const slot of erstellteSlotObjekte) {
             if(slot.VerweisAufTopf) zugewieseneTopfIdsInAnfrage.add(slot.VerweisAufTopf.toString());
        }
        expect(zugewieseneTopfIdsInAnfrage.size).toBe(8); // Erwartet 8 verschiedene Töpfe

        for (const topfId of zugewieseneTopfIdsInAnfrage) {
            const topf = await Kapazitaetstopf.findById(topfId);
            expect(topf.ListeDerAnfragen.map(id => id.toString())).toContain(anfrage_E2._id.toString());
        }
        for (const slot of erstellteSlotObjekte) {
            const slot_final = await Slot.findById(slot._id);
            expect(slot_final.zugewieseneAnfragen.map(id => id.toString())).toContain(anfrage_E2._id.toString());
        }
    });

    it('E3: Sollte das Entgelt für eine tägliche Anfrage mit 2 Abschnitten mit Übergang von Tag zu Nacht über 2 KWs korrekt berechnen', async () => {
        // ----- 1. Vorbereitung: Slot-Muster erstellen -----
        const grundentgelt_AB = 100;
        const grundentgelt_BC = 50;

        const slotDefinitionen1 = [
            // Abschnitt A->B
            { von: "A", bis: "B", Abschnitt: "AB_Strecke", Kalenderwoche: 1, Verkehrstag: "Mo-Fr", Grundentgelt: grundentgelt_AB, Verkehrsart: "SPFV", AbfahrtStunde: 22, AnkunftStunde: 23 },
            { von: "A", bis: "B", Abschnitt: "AB_Strecke", Kalenderwoche: 1, Verkehrstag: "Sa+So", Grundentgelt: grundentgelt_AB, Verkehrsart: "SPFV", AbfahrtStunde: 22, AnkunftStunde: 23 },
            { von: "A", bis: "B", Abschnitt: "AB_Strecke", Kalenderwoche: 2, Verkehrstag: "Mo-Fr", Grundentgelt: grundentgelt_AB, Verkehrsart: "SPFV", AbfahrtStunde: 22, AnkunftStunde: 23 },
            { von: "A", bis: "B", Abschnitt: "AB_Strecke", Kalenderwoche: 2, Verkehrstag: "Sa+So", Grundentgelt: grundentgelt_AB, Verkehrsart: "SPFV", AbfahrtStunde: 22, AnkunftStunde: 23 },
            ];
        const slotDefinitionen2 = [
            // Abschnitt B->C
            { von: "B", bis: "C", Abschnitt: "BC_Strecke", Kalenderwoche: 1, Verkehrstag: "Mo-Fr", Grundentgelt: grundentgelt_BC, Verkehrsart: "SPFV", AbfahrtStunde: 23, AnkunftStunde: 0 },
            { von: "B", bis: "C", Abschnitt: "BC_Strecke", Kalenderwoche: 1, Verkehrstag: "Sa+So", Grundentgelt: grundentgelt_BC, Verkehrsart: "SPFV", AbfahrtStunde: 23, AnkunftStunde: 0 },
            { von: "B", bis: "C", Abschnitt: "BC_Strecke", Kalenderwoche: 2, Verkehrstag: "Mo-Fr", Grundentgelt: grundentgelt_BC, Verkehrsart: "SPFV", AbfahrtStunde: 23, AnkunftStunde: 0 },
            { von: "B", bis: "C", Abschnitt: "BC_Strecke", Kalenderwoche: 2, Verkehrstag: "Sa+So", Grundentgelt: grundentgelt_BC, Verkehrsart: "SPFV", AbfahrtStunde: 23, AnkunftStunde: 0 },
        ];

        const erstellteSlotObjekte = [];
        for (const def of slotDefinitionen1) {
            const slotData = {
                slotTyp: 'TAG',
                von: def.von, bis: def.bis, Abschnitt: def.Abschnitt,
                Abfahrt: { stunde: def.AbfahrtStunde, minute: 0 }, Ankunft: { stunde: def.AnkunftStunde, minute: 0 },
                Verkehrstag: def.Verkehrstag, Kalenderwoche: def.Kalenderwoche, Verkehrsart: def.Verkehrsart, Grundentgelt: def.Grundentgelt
            };
            const response = await request(app).post('/api/slots').send(slotData);
            expect(response.status).toBe(201);
            erstellteSlotObjekte.push(response.body.data);
        }
        for (const def of slotDefinitionen2) {
            const slotData = {
                slotTyp: 'NACHT',
                von: def.von, bis: def.bis, Abschnitt: def.Abschnitt,
                Zeitfenster: '23-01',
                Mindestfahrzeit: 60,
                Maximalfahrzeit: 70,
                Verkehrstag: def.Verkehrstag, Kalenderwoche: def.Kalenderwoche, Grundentgelt: def.Grundentgelt
            };
            const response = await request(app).post('/api/slots').send(slotData);
            expect(response.status).toBe(201);
            erstellteSlotObjekte.push(response.body.data);
        }
        expect(erstellteSlotObjekte).toHaveLength(8);

        // ----- 2. Anfrage-Daten definieren und Anfrage erstellen -----
        const zeitraum_E2 = {
            start: "2024-12-30", // Mo, 30.12.2024 (Start KW1)
            ende: "2025-01-12" // So, 12.01.2025 (Ende KW2)
        };
        const anfrageVerkehrstag_E2 = "täglich";
        const erwarteteBetriebstage_E2 = calculateTotalOperatingDaysForAnfrage(zeitraum_E2, anfrageVerkehrstag_E2);
        expect(erwarteteBetriebstage_E2).toBe(14); // 2 volle Wochen * 7 Tage/Woche

        const anfrageData_E2 = {
            Zugnummer: "E2_MultiSegment", EVU: "EVU_MS",
            ListeGewuenschterSlotAbschnitte: [
                { von: "A", bis: "B", Abfahrtszeit: { stunde: 22, minute: 0 }, Ankunftszeit: { stunde: 23, minute: 0 } },
                { von: "B", bis: "C", Abfahrtszeit: { stunde: 23, minute: 10 }, Ankunftszeit: { stunde: 0, minute: 15 } }
            ],
            Verkehrsart: 'SPFV',
            Verkehrstag: anfrageVerkehrstag_E2,
            Zeitraum: zeitraum_E2,
            Email: "e2@test.com",
            Status: "validiert"
        };
        const anfrageErstelltResponse = await request(app).post('/api/anfragen').send(anfrageData_E2);
        expect(anfrageErstelltResponse.status).toBe(201);
        const anfrage_E2 = anfrageErstelltResponse.body.data;
        anfrageErstellt = await Anfrage.findById(anfrage_E2._id);
        console.log(anfrageErstellt);
        anfrageErstellt.Status = 'validiert';
        await anfrageErstellt.save();
        expect(anfrageErstellt.Status).toBe("validiert");

        // ----- 3. Aktion: Zuordnungsprozess anstoßen -----
        const zuordnenResponse = await request(app)
            .post(`/api/anfragen/${anfrage_E2._id}/zuordnen`)
            .send();
        
        // ----- 4. Überprüfung -----
        expect(zuordnenResponse.status).toBe(200);
        const aktualisierteAnfrage_E2 = zuordnenResponse.body.data;

        // 4.1 Entgelt
        const summeGrundentgelteProTag = grundentgelt_AB + grundentgelt_BC; // 100 + 50 = 150
        const erwartetesGesamtentgelt_E2 = erwarteteBetriebstage_E2 * summeGrundentgelteProTag; // 14 * 150 = 2100
        expect(aktualisierteAnfrage_E2.Entgelt).toBe(erwartetesGesamtentgelt_E2);

        // 4.2 Zugewiesene Slots
        expect(aktualisierteAnfrage_E2.ZugewieseneSlots).toHaveLength(8);
        // Stelle sicher, dass alle erstellten Slot-IDs in den ZugewiesenenSlots der Anfrage sind
        // und den korrekten Initialstatus haben
        for (const erstellterSlot of erstellteSlotObjekte) {
            const zuweisungEintrag = aktualisierteAnfrage_E2.ZugewieseneSlots.find(
                zs => zs.slot.toString() === erstellterSlot._id.toString()
            );
            expect(zuweisungEintrag).toBeDefined();
            expect(zuweisungEintrag.statusEinzelzuweisung).toBe('initial_in_konfliktpruefung_topf');
        }

        // 4.3 (Optional/Sekundär) Überprüfung der Kapazitätstöpfe und Slot-Verknüpfungen
        const zugewieseneTopfIdsInAnfrage = new Set();
        for (const slot of erstellteSlotObjekte) {
             if(slot.VerweisAufTopf) zugewieseneTopfIdsInAnfrage.add(slot.VerweisAufTopf.toString());
        }
        expect(zugewieseneTopfIdsInAnfrage.size).toBe(8); // Erwartet 8 verschiedene Töpfe

        for (const topfId of zugewieseneTopfIdsInAnfrage) {
            const topf = await Kapazitaetstopf.findById(topfId);
            expect(topf.ListeDerAnfragen.map(id => id.toString())).toContain(anfrage_E2._id.toString());
        }
        for (const slot of erstellteSlotObjekte) {
            const slot_final = await Slot.findById(slot._id);
            expect(slot_final.zugewieseneAnfragen.map(id => id.toString())).toContain(anfrage_E2._id.toString());
        }
    });
});