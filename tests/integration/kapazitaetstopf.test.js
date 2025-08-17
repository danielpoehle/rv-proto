// tests/integration/kapazitaetstopf.test.js
const request = require('supertest');
const mongoose = require('mongoose');
const app = require('../../server');
const {Slot} = require('../../models/Slot');
const Kapazitaetstopf = require('../../models/Kapazitaetstopf');

describe('Kapazitätstopf Vorgänger/Nachfolger Logik', () => {

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

    it('sollte Kapazitätstöpfe beim Erstellen korrekt mit ihren Vorgängern und Nachfolgern verknüpfen (inkl. KW-Wechsel)', async () => {
        // ---- SETUP: Gemeinsame Parameter für die Slots und Töpfe ----
        const commonParams = {
            von: "A", bis: "B", Abschnitt: "Test-Kette", Verkehrstag: "Sa+So", Grundentgelt: 100
        };

        // ---- AKTION 1: Erstelle den ersten Topf (KT_A) über Slot 1 ----
        // Dieser Topf ist das letzte Zeitfenster in KW 2.
        const slot1Data = {
            ...commonParams,
            slotTyp: 'NACHT',
            Kalenderwoche: 2,
            Zeitfenster: '23-01',
            Mindestfahrzeit: 60,
            Maximalfahrzeit: 75,
        };
        const response1 = await request(app).post('/api/slots').send(slot1Data);
        expect(response1.status).toBe(201);
        const topf_A_Id = response1.body.data.VerweisAufTopf;
        expect(topf_A_Id).toBeDefined();

        // Überprüfung 1: KT_A sollte initial keine Nachbarn haben
        let kt_A = await Kapazitaetstopf.findById(topf_A_Id);
        expect(kt_A.Zeitfenster).toBe('23-01');
        expect(kt_A.Kalenderwoche).toBe(2);
        expect(kt_A.TopfIDVorgänger).toBeNull();
        expect(kt_A.TopfIDNachfolger).toBeNull();


        // ---- AKTION 2: Erstelle den zweiten Topf (KT_B) über Slot 2 ----
        // Dieser Topf ist das erste Zeitfenster in KW 3. Er sollte KT_A als Vorgänger erkennen.
        const slot2Data = {
            ...commonParams,
            slotTyp: 'NACHT',
            Kalenderwoche: 3,
            Zeitfenster: '01-03',
            Mindestfahrzeit: 60,
            Maximalfahrzeit: 75,
        };
        const response2 = await request(app).post('/api/slots').send(slot2Data);
        expect(response2.status).toBe(201);
        const topf_B_Id = response2.body.data.VerweisAufTopf;
        expect(topf_B_Id).toBeDefined();

        // Überprüfung 2: KT_A und KT_B sollten jetzt verknüpft sein
        kt_A = await Kapazitaetstopf.findById(topf_A_Id);
        let kt_B = await Kapazitaetstopf.findById(topf_B_Id);

        //console.log(kt_A);
        //console.log(kt_B);
        
        expect(kt_A.TopfIDNachfolger.toString()).toBe(kt_B._id.toString());
        expect(kt_B.TopfIDVorgänger.toString()).toBe(kt_A._id.toString());
        expect(kt_B.TopfIDNachfolger).toBeNull(); // KT_B hat noch keinen Nachfolger


        // ---- AKTION 3: Erstelle den dritten Topf (KT_C) über Slot 3 ----
        // Dieser Topf ist das zweite Zeitfenster in KW 3. Er sollte KT_B als Vorgänger erkennen.
        const slot3Data = {
            ...commonParams,
            slotTyp: 'NACHT',
            Kalenderwoche: 3,
            Zeitfenster: '03-05',
            Mindestfahrzeit: 60,
            Maximalfahrzeit: 75,
        };
        const response3 = await request(app).post('/api/slots').send(slot3Data);
        expect(response3.status).toBe(201);
        const topf_C_Id = response3.body.data.VerweisAufTopf;
        expect(topf_C_Id).toBeDefined();

        // Überprüfung 3: Alle 3 Töpfe sollten jetzt korrekt miteinander verknüpft sein
        kt_A = await Kapazitaetstopf.findById(topf_A_Id); // Erneut laden
        kt_B = await Kapazitaetstopf.findById(topf_B_Id); // Erneut laden
        let kt_C = await Kapazitaetstopf.findById(topf_C_Id);

        expect(kt_A.TopfIDVorgänger).toBeNull();
        expect(kt_A.TopfIDNachfolger.toString()).toBe(kt_B._id.toString());
        expect(kt_B.TopfIDVorgänger.toString()).toBe(kt_A._id.toString());
        expect(kt_B.TopfIDNachfolger.toString()).toBe(kt_C._id.toString());
        expect(kt_C.TopfIDVorgänger.toString()).toBe(kt_B._id.toString());
        expect(kt_C.TopfIDNachfolger).toBeNull();      
        
    });
});