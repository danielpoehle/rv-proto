// slot-buchungs-app/controllers/slotController.js
const mongoose = require('mongoose');
const Slot = require('../models/Slot');
const Kapazitaetstopf = require('../models/Kapazitaetstopf');

// Hilfsfunktion: Findet oder erstellt einen Kapazitätstopf basierend auf Slot-Kriterien
async function findOrCreateKapazitaetstopf(slotData) {
    const { Abschnitt, Kalenderwoche, Verkehrstag, Verkehrsart: slotVerkehrsart, Abfahrt } = slotData;
    const passendesZeitfenster = Slot.mapAbfahrtstundeToKapazitaetstopfZeitfenster(Abfahrt.stunde);

    if (!passendesZeitfenster || !Abschnitt) return null;

    // 1. Versuche, Topf mit spezifischer Verkehrsart zu finden
    let topf = await Kapazitaetstopf.findOne({
        Abschnitt, Kalenderwoche, Verkehrstag,
        Zeitfenster: passendesZeitfenster, Verkehrsart: slotVerkehrsart
    });

    // 2. Wenn nicht gefunden, versuche, Topf mit Verkehrsart 'ALLE' zu finden
    if (!topf) {
        topf = await Kapazitaetstopf.findOne({
            Abschnitt, Kalenderwoche, Verkehrstag,
            Zeitfenster: passendesZeitfenster, Verkehrsart: 'ALLE'
        });
    }

    // 3. Wenn immer noch nicht gefunden, erstelle einen neuen Topf
    if (!topf) {
        console.log(`Kein passender Kapazitätstopf gefunden. Erstelle neuen Topf mit Verkehrsart: ${slotVerkehrsart}`);
        topf = new Kapazitaetstopf({
            Abschnitt, Kalenderwoche, Verkehrstag,
            Verkehrsart: slotVerkehrsart, // Neuer Topf erhält die spezifische Verkehrsart des Slots
            Zeitfenster: passendesZeitfenster,
        });
        try {
            await topf.save(); // TopfID und ZeitfensterStartStunde werden durch Hooks generiert
            console.log(`Neuer Kapazitätstopf ${topf.TopfID || topf._id} erstellt.`);
        } catch (createError) {
            // ... (Fehlerbehandlung wie zuvor, ggf. erneuter Find-Versuch bei unique-Kollision) ...
            if (createError.code === 11000) {
                console.warn("Kollision beim Erstellen des Kapazitätstopfes, versuche erneut zu finden:", createError.keyValue);
                const queryForRetry = { Abschnitt, Kalenderwoche, Verkehrstag, Zeitfenster: passendesZeitfenster,
                    $or: [{ Verkehrsart: slotVerkehrsart }, { Verkehrsart: 'ALLE' }] };
                topf = await Kapazitaetstopf.findOne(queryForRetry);
                if (!topf) {
                    console.error("Konnte Kapazitätstopf auch nach Kollision nicht finden.", createError);
                    throw createError;
                }
            } else {
                console.error("Fehler beim automatischen Erstellen des Kapazitätstopfes:", createError);
                throw createError;
            }
        }
    }
    return topf;
}


// Hilfsfunktion zum Aktualisieren von ListeDerSlots und maxKapazitaet eines Topfes
async function updateTopfSlotsAndCapacity(topfId, slotId, operationType) { // op: 'add' or 'remove'
    if (!topfId) return;
    const topf = await Kapazitaetstopf.findById(topfId);
    if (!topf) {
        console.warn(`Kapazitätstopf ${topfId} nicht gefunden für Kapazitätsupdate.`);
        return;
    }

    const slotObjectId = new mongoose.Types.ObjectId(slotId);
    let lengthBefore = topf.ListeDerSlots.length;

    if (operationType === 'add') {
        topf.ListeDerSlots.addToSet(slotObjectId);
    } else if (operationType === 'remove') {
        topf.ListeDerSlots.pull(slotObjectId);
    }

    // Nur speichern und loggen, wenn sich die Liste tatsächlich geändert hat
    if (topf.ListeDerSlots.length !== lengthBefore || topf.isModified('ListeDerSlots')) {
        topf.maxKapazitaet = Math.floor(0.7 * topf.ListeDerSlots.length);
        topf.markModified('maxKapazitaet'); // Sicherstellen, dass auch 0 gespeichert wird
        await topf.save();
        console.log(`Kapazitätstopf ${topf.TopfID || topf._id} aktualisiert: ${operationType} slot ${slotId}. Neue maxKap: ${topf.maxKapazitaet}. Slots: ${topf.ListeDerSlots.length}`);
    }
}

// @desc    Erstellt einen neuen Infrastruktur-Slot
// @route   POST /api/slots
exports.createSlot = async (req, res) => {
    try {
        const { von, bis, Abschnitt, Abfahrt, Ankunft, Verkehrstag, Kalenderwoche, Verkehrsart, Grundentgelt } = req.body;

        // ... (Validierung von Pflichtfeldern und Ankunft > Abfahrt) ...
        if (!Abschnitt) return res.status(400).json({message: 'Abschnitt ist ein Pflichtfeld.'});
        // ...

        const potenziellerTopf = await findOrCreateKapazitaetstopf({ Abschnitt, Kalenderwoche, Verkehrstag, Verkehrsart, Abfahrt });

        const neuerSlot = new Slot({
            von, bis, Abschnitt, Abfahrt, Ankunft, Verkehrstag,
            Kalenderwoche, Verkehrsart, Grundentgelt,
            VerweisAufTopf: potenziellerTopf ? potenziellerTopf._id : null
        });

        const gespeicherterSlot = await neuerSlot.save(); // pre-save Hook für SlotID_Sprechend läuft

        // Bidirektionale Verknüpfung: Slot zum (gefundenen oder neu erstellten) Kapazitätstopf hinzufügen
        if (gespeicherterSlot.VerweisAufTopf) {
            await updateTopfSlotsAndCapacity(gespeicherterSlot.VerweisAufTopf, gespeicherterSlot._id, 'add');
        }

        res.status(201).json({
            message: 'Slot erfolgreich erstellt und Kapazitätstopf-Verknüpfung hergestellt/geprüft.',
            data: gespeicherterSlot
        });

    } catch (error) {
        // ... (Fehlerbehandlung für Slot-Erstellung) ...
        console.error('Fehler beim Erstellen des Slots:', error);
        // ... (Standardfehlerbehandlung)
         if (error.name === 'ValidationError') {
            return res.status(400).json({ message: 'Validierungsfehler.', errors: Object.values(error.errors).map(e => e.message) });
        }
        if (error.code === 11000 && error.keyPattern && error.keyPattern.SlotID_Sprechend) {
             return res.status(409).json({ message: 'Ein Slot mit diesen Eigenschaften (resultierend in derselben SlotID_Sprechend) existiert bereits.'});
        }
        res.status(500).json({ message: 'Serverfehler beim Erstellen des Slots.' });
    }
};

// @desc    Ruft alle Slots ab
// @route   GET /api/slots
exports.getAllSlots = async (req, res) => {
    try {
        const queryParams = req.query;
        let filter = {};
        let sortOptions = {};

        // Filter-Logik (Beispiele)
        if (queryParams.von) filter.von = { $regex: queryParams.von, $options: 'i' };
        if (queryParams.bis) filter.bis = { $regex: queryParams.bis, $options: 'i' };
        if (queryParams.Verkehrsart) filter.Verkehrsart = queryParams.Verkehrsart;
        if (queryParams.Verkehrstag) filter.Verkehrstag = queryParams.Verkehrstag;
        if (queryParams.Kalenderwoche) filter.Kalenderwoche = queryParams.Kalenderwoche;
        // TODO: Filtern nach Abfahrts-/Ankunftszeit (erfordert komplexere Bereichsabfragen)

        // Sortier-Logik
        if (queryParams.sortBy) {
            const parts = queryParams.sortBy.split(':');
            sortOptions[parts[0]] = parts[1] === 'desc' ? -1 : 1;
        } else {
            sortOptions['Kalenderwoche'] = 1; // Standard: nach KW sortieren
            sortOptions['Abfahrt.stunde'] = 1;
            sortOptions['Abfahrt.minute'] = 1;
        }

        // Paginierung
        const page = parseInt(queryParams.page, 10) || 1;
        const limit = parseInt(queryParams.limit, 10) || 20; // Standard-Limit
        const skip = (page - 1) * limit;

        const slots = await Slot.find(filter)
                                .sort(sortOptions)
                                .skip(skip)
                                .limit(limit)
                                .populate('KapazitaetstopfReferenzen', 'TopfID TopfName'); // Beispiel für Populate

        const totalSlots = await Slot.countDocuments(filter);

        res.status(200).json({
            message: 'Slots erfolgreich abgerufen.',
            data: slots,
            currentPage: page,
            totalPages: Math.ceil(totalSlots / limit),
            totalCount: totalSlots
        });

    } catch (error) {
        console.error('Fehler beim Abrufen der Slots:', error);
        res.status(500).json({ message: 'Serverfehler beim Abrufen der Slots.' });
    }
};

// @desc    Ruft einen einzelnen Slot anhand seiner ID ab
// @route   GET /api/slots/:slotId
exports.getSlotById = async (req, res) => {
    try {
        const slotIdParam = req.params.slotId;
        let queryConditions = [];

        queryConditions.push({ SlotID_Sprechend: slotIdParam });
        if (mongoose.Types.ObjectId.isValid(slotIdParam)) {
            queryConditions.push({ _id: slotIdParam });
        }

        const slot = await Slot.findOne({ $or: queryConditions })
                               .populate('KapazitaetstopfReferenzen', 'TopfID TopfName'); // Beispiel

        if (!slot) {
            return res.status(404).json({ message: 'Slot nicht gefunden.' });
        }

        res.status(200).json({
            message: 'Slot erfolgreich abgerufen.',
            data: slot
        });

    } catch (error) {
        console.error('Fehler beim Abrufen des Slots anhand der ID:', error);
        if (error.name === 'CastError') {
            return res.status(400).json({ message: 'Ungültiges ID-Format.' });
        }
        res.status(500).json({ message: 'Serverfehler beim Abrufen des Slots.' });
    }
};

// @desc    Sucht freie Slots für die Konfliktlösung
// @route   GET /api/slots/konflikt-alternativen
// @query   kapazitaetstopfId, verkehrsart, verkehrstag, kalenderwoche, vonOrt
exports.getKonfliktAlternativenSlots = async (req, res) => {
    try {
        const {
            kapazitaetstopfId, // Erwartet eine ObjectId als String
            verkehrsart,
            verkehrstag,
            kalenderwoche,
            vonOrt
        } = req.query;

        // Validierung der Pflicht-Query-Parameter für diese spezielle Suche
        if (!kapazitaetstopfId || !verkehrsart || !verkehrstag || !kalenderwoche || !vonOrt) {
            return res.status(400).json({
                message: 'Bitte alle erforderlichen Suchparameter angeben: kapazitaetstopfId, verkehrsart, verkehrstag, kalenderwoche, vonOrt.'
            });
        }

        // Aufbau des Filterobjekts
        const filterConditions = {
            zugewieseneAnfragen: { $size: 0 }, // Kriterium 1: Liste der Anfragen ist leer
            KapazitaetstopfReferenzen: kapazitaetstopfId, // Kriterium 2: Liegt im Kapazitätstopf
            Verkehrsart: verkehrsart, // Kriterium 3
            Verkehrstag: verkehrstag, // Kriterium 4
            Kalenderwoche: kalenderwoche, // Kriterium 5
            von: vonOrt // Kriterium 6
            // Abfahrt und Ankunft werden nicht gefiltert
        };

        const alternativeSlots = await Slot.find(filterConditions)
                                           .sort({ 'Abfahrt.stunde': 1, 'Abfahrt.minute': 1 }); // Sortierung nach Abfahrtszeit als Standard

        if (alternativeSlots.length === 0) {
            return res.status(404).json({
                message: 'Keine passenden alternativen Slots für die angegebenen Kriterien gefunden.',
                data: []
            });
        }

        res.status(200).json({
            message: 'Alternative Slots erfolgreich abgerufen.',
            count: alternativeSlots.length,
            data: alternativeSlots
        });

    } catch (error) {
        console.error('Fehler bei der Suche nach Konflikt-Alternativ-Slots:', error);
        if (error.name === 'CastError' && error.path === 'KapazitaetstopfReferenzen') {
             // Spezieller Fehler, falls kapazitaetstopfId kein gültiges ObjectId-Format hat
            return res.status(400).json({ message: 'Ungültiges Format für kapazitaetstopfId.' });
        }
        res.status(500).json({ message: 'Serverfehler bei der Suche nach alternativen Slots.' });
    }
};

// @desc    Aktualisiert einen bestehenden Slot
// @route   PUT /api/slots/:slotId
exports.updateSlot = async (req, res) => {
    try {
        const slotIdParam = req.params.slotId;
        // ... (Slot finden - Logik bleibt) ...
        let queryConditions = [{ SlotID_Sprechend: slotIdParam }];
        if (mongoose.Types.ObjectId.isValid(slotIdParam)) {
            queryConditions.push({ _id: slotIdParam });
        }
        let slot = await Slot.findOne({ $or: queryConditions });
        if (!slot) { return res.status(404).json({ message: 'Slot nicht gefunden.' }); }


        const alterVerweisAufTopf = slot.VerweisAufTopf ? slot.VerweisAufTopf : null;

        // Update Slot properties
        const allowedUpdates = ['von', 'bis', 'Abschnitt', 'Abfahrt', 'Ankunft', 'Verkehrstag', 'Kalenderwoche', 'Verkehrsart', 'Grundentgelt'];
        // ... (Updates anwenden - Logik bleibt) ...
         const updates = req.body;
        let relevanteFelderGeaendert = false;
        for (const key in updates) {
            if (allowedUpdates.includes(key)) {
                if ((key === 'Abfahrt' || key === 'Ankunft') && typeof updates[key] === 'object') {
                    slot[key] = { ...slot[key], ...updates[key] };
                } else {
                    slot[key] = updates[key];
                }
                slot.markModified(key);
                if (['Abschnitt', 'Kalenderwoche', 'Verkehrstag', 'Verkehrsart', 'Abfahrt', 'Grundentgelt'].includes(key)) {
                    relevanteFelderGeaendert = true;
                }
            }
        }
        // ... (Ankunftszeit > Abfahrtszeit Validierung) ...


        // Wenn sich für Topf-Zuordnung relevante Felder geändert haben, neuen Topf bestimmen
        let neuerVerweisAufTopf = alterVerweisAufTopf; // Initial annehmen, dass es gleich bleibt
        if (relevanteFelderGeaendert) {
            const potenziellerNeuerTopf = await findOrCreateKapazitaetstopf({
                Abschnitt: slot.Abschnitt,
                Kalenderwoche: slot.Kalenderwoche,
                Verkehrstag: slot.Verkehrstag,
                Verkehrsart: slot.Verkehrsart,
                Abfahrt: slot.Abfahrt
            });
            neuerVerweisAufTopf = potenziellerNeuerTopf ? potenziellerNeuerTopf._id : null;
            slot.VerweisAufTopf = neuerVerweisAufTopf;
        }

        const aktualisierterSlot = await slot.save(); // pre-save Hook für SlotID_Sprechend läuft

        // Bidirektionale Verknüpfung managen, wenn sich der Verweis geändert hat
        const finalerNeuerVerweis = aktualisierterSlot.VerweisAufTopf ? aktualisierterSlot.VerweisAufTopf : null;

        if ((alterVerweisAufTopf && !finalerNeuerVerweis) || 
            (!alterVerweisAufTopf && finalerNeuerVerweis) ||
            (alterVerweisAufTopf && finalerNeuerVerweis && !alterVerweisAufTopf.equals(finalerNeuerVerweis))) {
            
            if (alterVerweisAufTopf) {
                await updateTopfSlotsAndCapacity(alterVerweisAufTopf, aktualisierterSlot._id, 'remove');
            }
            if (finalerNeuerVerweis) {
                await updateTopfSlotsAndCapacity(finalerNeuerVerweis, aktualisierterSlot._id, 'add');
            }
        }

        res.status(200).json({
            message: 'Slot erfolgreich aktualisiert, Kapazitätstopf-Verknüpfung geprüft/hergestellt.',
            data: aktualisierterSlot
        });

    } catch (error) {
        // ... (Fehlerbehandlung für Slot-Update) ...
        console.error('Fehler beim Aktualisieren des Slots:', error);
        // ...
        res.status(500).json({ message: 'Serverfehler beim Aktualisieren des Slots.' });
    }
};

// @desc    Löscht einen Slot
// @route   DELETE /api/slots/:slotId
exports.deleteSlot = async (req, res) => {
    try {
        const slotIdParam = req.params.slotId;

        let queryConditions = [{ SlotID_Sprechend: slotIdParam }];
        if (mongoose.Types.ObjectId.isValid(slotIdParam)) {
            queryConditions.push({ _id: slotIdParam });
        }
        const slot = await Slot.findOne({ $or: queryConditions });

        if (!slot) {
            return res.status(404).json({ message: 'Slot nicht gefunden.' });
        }

        // Sicherheitsprüfung: Slot nicht löschen, wenn ihm Anfragen zugewiesen sind
        if (slot.zugewieseneAnfragen && slot.zugewieseneAnfragen.length > 0) {
            return res.status(409).json({ // 409 Conflict
                message: 'Slot kann nicht gelöscht werden, da ihm bereits Anfragen zugewiesen sind.',
                details: `Dem Slot sind ${slot.zugewieseneAnfragen.length} Anfrage(n) zugewiesen.`
            });
        }

        // Wenn keine zugewiesenen Anfragen, dann Slot löschen
        // Die Methode .deleteOne() ist für das Dokument-Objekt selbst
        await slot.deleteOne();
        // Alternativ: await Slot.findByIdAndDelete(slot._id); wenn man nur die ID hätte

        res.status(200).json({ // Oder 204 No Content, wenn keine Daten zurückgesendet werden sollen
            message: 'Slot erfolgreich gelöscht.',
            data: { id: slot._id, slotIdSprechend: slot.SlotID_Sprechend } // Bestätigungsinformationen
        });

    } catch (error) {
        console.error('Fehler beim Löschen des Slots:', error);
        if (error.name === 'CastError') {
            return res.status(400).json({ message: 'Ungültiges ID-Format.' });
        }
        res.status(500).json({ message: 'Serverfehler beim Löschen des Slots.' });
    }
};