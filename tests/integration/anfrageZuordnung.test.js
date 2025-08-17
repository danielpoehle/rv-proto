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
                start: GLOBAL_KW1_START_DATE_ISO, // Mo, 30.12.2024 (Start KW1)
                ende: "2025-01-12T23:59:59.999Z" // So, 12.01.2025 (Ende KW2)
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
                start: GLOBAL_KW1_START_DATE_ISO, // Mo, 30.12.2024 (Start KW1)
                ende: "2025-01-12T23:59:59.999Z"  // So, 12.01.2025 (Ende KW2)
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
            EVU: "DB Fernverkehr AG",
            ListeGewuenschterSlotAbschnitte: [{
                von: "StadtA", bis: "StadtB",
                Abfahrtszeit: { stunde: 8, minute: 0 }, Ankunftszeit: { stunde: 9, minute: 0 }
            }],
            Verkehrsart: "SPFV",
            Verkehrstag: "täglich",
            Zeitraum: {
                start: GLOBAL_KW1_START_DATE_ISO, // Mo, 30.12.2024 (Start KW1)
                ende: "2025-01-12T23:59:59.999Z" // So, 12.01.2025 (Ende KW2)
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

        // 4.3 Slots zugewiesene Anfragen
        const slot1_final = await Slot.findById(slotMoFrKW1._id);
        const slot2_final = await Slot.findById(slotSaSoKW1._id);
        const slot3_final = await Slot.findById(slotMoFrKW2._id);
        const slot4_final = await Slot.findById(slotSaSoKW2._id);

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
        const zeitraum_E1 = { start: "2025-03-03T00:00:00.000Z", ende: "2025-03-05T23:59:59.999Z" }; // Mo, Di, Mi
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
            start: GLOBAL_KW1_START_DATE_ISO, // Mo, 30.12.2024 (Start KW1)
            ende: "2025-01-12T23:59:59.999Z"  // So, 12.01.2025 (Ende KW2) => 14 Tage
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
            start: GLOBAL_KW1_START_DATE_ISO, // Mo, 30.12.2024 (Start KW1)
            ende: "2025-01-12T23:59:59.999Z"  // So, 12.01.2025 (Ende KW2) => 14 Tage
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