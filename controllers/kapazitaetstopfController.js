// slot-buchungs-app/controllers/kapazitaetstopfController.js
const mongoose = require('mongoose');
const Kapazitaetstopf = require('../models/Kapazitaetstopf'); // Das aktualisierte Modell
const Slot = require('../models/Slot'); // Benötigt für die Prüfung von Referenzen
const kapazitaetstopfService = require('../utils/kapazitaetstopf.service'); // <-- NEUER Import

// @desc    Erstellt einen neuen Kapazitätstopf
// @route   POST /api/kapazitaetstoepfe
exports.createKapazitaetstopf = async (req, res) => {
    try {
        const neuerTopf = await kapazitaetstopfService.createAndLinkKapazitaetstopf(req.body);

        res.status(201).json({
            message: 'Kapazitätstopf erfolgreich erstellt und mit Nachbarn verknüpft (falls vorhanden).',
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
            .populate({
                path: 'ListeDerSlots', // Lade die zugeordneten Slots
                select: 'SlotID_Sprechend Linienbezeichnung Abschnitt zugewieseneAnfragen' // Wähle die benötigten Felder
            })
            .populate({
                path: 'ListeDerAnfragen', // Lade die zugeordneten Anfragen
                select: 'AnfrageID_Sprechend Status' // Wähle die benötigten Felder
            })
            .populate('TopfIDVorgänger', 'TopfID') // Lade die sprechende ID des Vorgängers
            .populate('TopfIDNachfolger', 'TopfID'); // Lade die sprechende ID des Nachfolgers


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

// @desc    Aktualisiert einen Kapazitätstopf
// @route   PUT /api/kapazitaetstoepfe/:topfIdOderMongoId
exports.updateKapazitaetstopf = async (req, res) => {
    try {
        const idParam = req.params.topfIdOderMongoId;
        const updates = req.body || {};

        let topf = await Kapazitaetstopf.findOne({ 
            $or: [{ _id: mongoose.Types.ObjectId.isValid(idParam) ? idParam : null }, { TopfID: idParam }]
        });

        if (!topf) {
            return res.status(404).json({ message: 'Kapazitätstopf nicht gefunden.' });
        }

        // Alte Nachbarn und Eigenschaften für die Verknüpfung merken
        const alterVorgängerId = topf.TopfIDVorgänger;
        const alterNachfolgerId = topf.TopfIDNachfolger;
        const alteLinkEigenschaften = {
            Abschnitt: topf.Abschnitt, Kalenderwoche: topf.Kalenderwoche, Verkehrstag: topf.Verkehrstag,
            Verkehrsart: topf.Verkehrsart, Zeitfenster: topf.Zeitfenster
        };

        // Update durchführen
        const allowedUpdates = [ 'Abschnitt', 'Verkehrsart', 'Zeitfenster', 'Kalenderwoche', 'Verkehrstag' /* weitere Metadaten */ ];
        let linkEigenschaftenGeaendert = false;
        for (const key in updates) {
            if (allowedUpdates.includes(key)) {
                if(JSON.stringify(topf[key]) !== JSON.stringify(updates[key])) { // Prüfe ob es eine echte Änderung ist
                    topf[key] = updates[key];
                    if(['Abschnitt', 'Kalenderwoche', 'Verkehrstag', 'Verkehrsart', 'Zeitfenster'].includes(key)) {
                        linkEigenschaftenGeaendert = true;
                    }
                }
            }
        }
        
        // Wenn keine relevanten Änderungen, nur speichern und antworten
        if (!linkEigenschaftenGeaendert) {
            const aktualisierterTopf = await topf.save();
            return res.status(200).json({ message: 'Kapazitätstopf aktualisiert (keine Änderung an Nachbar-Verknüpfungen).', data: aktualisierterTopf });
        }

        // -- Wenn sich Link-Eigenschaften geändert haben --
        
        // 1. Topf von alten Nachbarn trennen (falls vorhanden)
        if (alterVorgängerId) {
            await Kapazitaetstopf.updateOne({ _id: alterVorgängerId }, { $set: { TopfIDNachfolger: null } });
            console.log(`Alte Verknüpfung zu Vorgänger ${alterVorgängerId} getrennt.`);
        }
        if (alterNachfolgerId) {
            await Kapazitaetstopf.updateOne({ _id: alterNachfolgerId }, { $set: { TopfIDVorgänger: null } });
            console.log(`Alte Verknüpfung zu Nachfolger ${alterNachfolgerId} getrennt.`);
        }
        
        // Verweise im aktuellen Topf vor dem Speichern zurücksetzen
        topf.TopfIDVorgänger = null;
        topf.TopfIDNachfolger = null;

        // Speichere den Topf mit seinen neuen Eigenschaften
        await topf.save();       

        // ----- Finde und verknüpfe Vorgänger und Nachfolger -----
        const finalerTopf = await kapazitaetstopfService.findAndLinkLogic(topf);

        res.status(200).json({
            message: 'Kapazitätstopf erfolgreich aktualisiert und neu mit Nachbarn verknüpft.',
            data: finalerTopf
        });
    } catch (error) {
        // ... (Fehlerbehandlung bleibt wie zuvor) ...
        console.error('Fehler beim Update des Kapazitätstopfes:', error);
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

        // --- Verknüpfungen zu Nachbarn auflösen ---
        if (topf.TopfIDVorgänger) {
            await Kapazitaetstopf.updateOne({ _id: topf.TopfIDVorgänger }, { $set: { TopfIDNachfolger: null } });
            console.log(`Nachfolger-Verweis beim Vorgänger ${topf.TopfIDVorgänger} entfernt.`);
        }
        if (topf.TopfIDNachfolger) {
            await Kapazitaetstopf.updateOne({ _id: topf.TopfIDNachfolger }, { $set: { TopfIDVorgänger: null } });
            console.log(`Vorgänger-Verweis beim Nachfolger ${topf.TopfIDNachfolger} entfernt.`);
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

// @desc    Liefert eine aggregierte Zusammenfassung aller Kapazitätstöpfe
// @route   GET /api/kapazitaetstoepfe/summary
exports.getKapazitaetstopfSummary = async (req, res) => {
    try {
        const summary = await Kapazitaetstopf.aggregate([
            // Stufe 1: Füge ein temporäres Feld hinzu, um zu prüfen, ob der Topf überbucht ist.
            {
                $addFields: {
                    isOverbooked: { 
                        $gt: [ { $size: { "$ifNull": [ "$ListeDerAnfragen", [] ] } }, "$maxKapazitaet" ] 
                    }
                }
            },
            // Stufe 2: Gruppiere alle Dokumente nach dem Feld "Abschnitt".
            {
                $group: {
                    _id: { // Zusammengesetzter Schlüssel
                        abschnitt: "$Abschnitt",
                        verkehrsart: "$Verkehrsart"
                    },
                    anzahlToepfe: { $sum: 1 },
                    minKW: { $min: "$Kalenderwoche" },
                    maxKW: { $max: "$Kalenderwoche" },
                    konfliktAnzahl: {
                        $sum: { $cond: [ "$isOverbooked", 1, 0 ] }
                    }
                    // Das Feld "verkehrsarten: { $addToSet: ... }" wird nicht mehr benötigt.
                }
            },
            // Stufe 3: Formatiere das Ausgabe-Dokument für eine saubere Antwort.
            {
                $project: {
                    _id: 0, // Die technische _id entfernen
                    abschnitt: "$_id.abschnitt", // Feld aus dem Gruppierungsschlüssel extrahieren
                    verkehrsart: "$_id.verkehrsart", // Feld aus dem Gruppierungsschlüssel extrahieren
                    anzahlToepfe: 1,
                    minKW: 1,
                    maxKW: 1,
                    mitKonflikt: "$konfliktAnzahl",
                    ohneKonflikt: { $subtract: ["$anzahlToepfe", "$konfliktAnzahl"] }
                }
            },
            // Stufe 4: Sortiere das Endergebnis alphabetisch nach Abschnitt und Verkehrsart.
            {
                $sort: {
                    abschnitt: 1, // Zuerst nach Abschnitt sortieren
                    verkehrsart: 1 // Dann innerhalb des Abschnitts nach Verkehrsart
                }
            }
        ]);

        res.status(200).json({
            message: 'Zusammenfassung der Kapazitätstöpfe erfolgreich abgerufen.',
            data: summary
        });

    } catch (error) {
        console.error('Fehler bei der Erstellung der Kapazitätstopf-Zusammenfassung:', error);
        res.status(500).json({ message: 'Serverfehler bei der Erstellung der Zusammenfassung.' });
    }
};