// slot-buchungs-app/controllers/kapazitaetstopfController.js
const mongoose = require('mongoose');
const Kapazitaetstopf = require('../models/Kapazitaetstopf'); // Das aktualisierte Modell
const Slot = require('../models/Slot'); // Benötigt für die Prüfung von Referenzen

// @desc    Erstellt einen neuen Kapazitätstopf
// @route   POST /api/kapazitaetstoepfe
exports.createKapazitaetstopf = async (req, res) => {
    try {
        const {
            // TopfID wird generiert
            Abschnitt,
            Verkehrsart,
            // maxKapazitaet wird nicht mehr direkt gesetzt, default ist 0
            Zeitfenster,
            // ZeitfensterStartStunde wird durch Hook generiert
            Kalenderwoche,
            Verkehrstag,
            // ListeDerSlots wird initial leer sein
            TopfIDVorgänger,
            TopfIDNachfolger
        } = req.body;

        const neuerTopf = new Kapazitaetstopf({
            Abschnitt,
            Verkehrsart,
            Zeitfenster,
            Kalenderwoche,
            Verkehrstag,
            // ListeDerSlots wird standardmäßig leer sein ([])
            // maxKapazitaet wird standardmäßig 0 sein
            TopfIDVorgänger: TopfIDVorgänger || null,
            TopfIDNachfolger: TopfIDNachfolger || null
        });

        await neuerTopf.save(); // Hooks für TopfID und ZeitfensterStartStunde laufen

        res.status(201).json({
            message: 'Kapazitätstopf erfolgreich erstellt (initial ohne Slots und maxKapazitaet=0).',
            data: neuerTopf
        });

    } catch (error) {
        // ... (Fehlerbehandlung bleibt wie zuvor) ...
        console.error('Fehler beim Erstellen des Kapazitätstopfes:', error);
        if (error.name === 'ValidationError') {
            const messages = Object.values(error.errors).map(val => val.message);
            return res.status(400).json({ message: 'Validierungsfehler.', errors: messages });
        }
        if (error.code === 11000 && error.keyPattern && error.keyPattern.TopfID) {
             return res.status(409).json({ message: `Ein Kapazitätstopf mit den generierenden Eigenschaften (Abschnitt, KW, Verkehrsart, Verkehrstag) existiert bereits und würde dieselbe TopfID erzeugen.`});
        }
        res.status(500).json({ message: 'Serverfehler beim Erstellen des Kapazitätstopfes.' });
    }
};

// @desc    Ruft alle Kapazitätstöpfe ab
// @route   GET /api/kapazitaetstoepfe
exports.getAllKapazitaetstoepfe = async (req, res) => {
    try {
        const queryParams = req.query;
        let filter = {};
        let sortOptions = { TopfID: 1 }; // Standard-Sortierung nach der generierten ID

        // Filter-Logik an das neue Modell anpassen
        if (queryParams.Abschnitt) filter.Abschnitt = { $regex: queryParams.Abschnitt, $options: 'i' };
        if (queryParams.TopfID) filter.TopfID = { $regex: queryParams.TopfID, $options: 'i' }; // Suche nach generierter ID
        if (queryParams.Verkehrsart) filter.Verkehrsart = queryParams.Verkehrsart;
        if (queryParams.Kalenderwoche) filter.Kalenderwoche = parseInt(queryParams.Kalenderwoche, 10);
        if (queryParams.Verkehrstag) filter.Verkehrstag = queryParams.Verkehrstag;
        if (queryParams.Zeitfenster) filter.Zeitfenster = queryParams.Zeitfenster;
        if (queryParams.ZeitfensterStartStunde) filter.ZeitfensterStartStunde = parseInt(queryParams.ZeitfensterStartStunde, 10);


        if (queryParams.sortBy) {
            const parts = queryParams.sortBy.split(':');
            sortOptions = {};
            sortOptions[parts[0]] = parts[1] === 'desc' ? -1 : 1;
        }

        const page = parseInt(queryParams.page, 10) || 1;
        const limit = parseInt(queryParams.limit, 10) || 10;
        const skip = (page - 1) * limit;

        const toepfe = await Kapazitaetstopf.find(filter)
            .populate('ListeDerSlots', 'SlotID_Sprechend von bis') // Beispiel für Populate
            .populate('ListeDerAnfragen', 'AnfrageID_Sprechend Zugnummer') // Beispiel für Populate
            .sort(sortOptions)
            .skip(skip)
            .limit(limit);

        const totalToepfe = await Kapazitaetstopf.countDocuments(filter);

        res.status(200).json({
            message: 'Kapazitätstöpfe erfolgreich abgerufen.',
            data: toepfe,
            currentPage: page,
            totalPages: Math.ceil(totalToepfe / limit),
            totalCount: totalToepfe
        });

    } catch (error) {
        console.error('Fehler beim Abrufen der Kapazitätstöpfe:', error);
        res.status(500).json({ message: 'Serverfehler beim Abrufen der Kapazitätstöpfe.' });
    }
};

// @desc    Ruft einen einzelnen Kapazitätstopf anhand seiner ID ab
// @route   GET /api/kapazitaetstoepfe/:topfIdOderMongoId
exports.getKapazitaetstopfById = async (req, res) => {
    try {
        const idParam = req.params.topfIdOderMongoId;
        let queryConditions = [];

        // Suche nach der generierten TopfID
        queryConditions.push({ TopfID: idParam });
        // Wenn der Parameter eine gültige MongoDB ObjectId ist, auch danach suchen
        if (mongoose.Types.ObjectId.isValid(idParam)) {
            queryConditions.push({ _id: idParam });
        }

        const topf = await Kapazitaetstopf.findOne({ $or: queryConditions })
            .populate('ListeDerSlots', 'SlotID_Sprechend von bis Abfahrt Ankunft Verkehrsart')
            .populate('ListeDerAnfragen', 'AnfrageID_Sprechend Zugnummer EVU Status');

        if (!topf) {
            return res.status(404).json({ message: 'Kapazitätstopf nicht gefunden.' });
        }

        res.status(200).json({
            message: 'Kapazitätstopf erfolgreich abgerufen.',
            data: topf
        });

    } catch (error) {
        console.error('Fehler beim Abrufen des Kapazitätstopfes anhand der ID:', error);
        if (error.name === 'CastError') {
            return res.status(400).json({ message: 'Ungültiges ID-Format für MongoDB _id.' });
        }
        res.status(500).json({ message: 'Serverfehler beim Abrufen des Kapazitätstopfes.' });
    }
};


// @desc    Löscht einen Kapazitätstopf
// @route   DELETE /api/kapazitaetstoepfe/:topfIdOderMongoId
exports.deleteKapazitaetstopf = async (req, res) => {
    try {
        const idParam = req.params.topfIdOderMongoId;

        let queryConditions = [{ TopfID: idParam }];
        if (mongoose.Types.ObjectId.isValid(idParam)) {
            queryConditions.push({ _id: idParam });
        }
        const topf = await Kapazitaetstopf.findOne({ $or: queryConditions });

        if (!topf) {
            return res.status(404).json({ message: 'Kapazitätstopf nicht gefunden.' });
        }

        // Sicherheitsprüfung 1: Hat der Topf noch direkt zugeordnete Slots oder Anfragen?
        if ((topf.ListeDerSlots && topf.ListeDerSlots.length > 0) ||
            (topf.ListeDerAnfragen && topf.ListeDerAnfragen.length > 0)) {
            return res.status(409).json({ // 409 Conflict
                message: 'Kapazitätstopf kann nicht gelöscht werden, da ihm direkt Slots oder Anfragen zugeordnet sind. Bitte diese Zuweisungen zuerst entfernen.'
            });
        }

        // Sicherheitsprüfung 2: Wird der Topf noch von Slots referenziert?
        // Dies prüft das Feld KapazitaetstopfReferenzen in den Slot-Dokumenten.
        const referencingSlots = await Slot.find({ KapazitaetstopfReferenzen: topf._id }).limit(1); // limit(1) für Performance, wir brauchen nur wissen, OB es welche gibt
        if (referencingSlots.length > 0) {
            return res.status(409).json({
                message: `Kapazitätstopf kann nicht gelöscht werden, da er noch von mindestens einem Slot (z.B. Slot-ID: ${referencingSlots[0].SlotID_Sprechend || referencingSlots[0]._id}) referenziert wird.`
            });
        }
        
        // Wenn keine Abhängigkeiten bestehen, Topf löschen
        await topf.deleteOne();

        res.status(200).json({
            message: 'Kapazitätstopf erfolgreich gelöscht.',
            data: { id: topf._id, topfId: topf.TopfID }
        });

    } catch (error) {
        console.error('Fehler beim Löschen des Kapazitätstopfes:', error);
        if (error.name === 'CastError') {
            return res.status(400).json({ message: 'Ungültiges ID-Format.' });
        }
        res.status(500).json({ message: 'Serverfehler beim Löschen des Kapazitätstopfes.' });
    }
};