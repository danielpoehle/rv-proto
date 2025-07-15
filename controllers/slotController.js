// slot-buchungs-app/controllers/slotController.js
const mongoose = require('mongoose');
const Slot = require('../models/Slot');
const Kapazitaetstopf = require('../models/Kapazitaetstopf');
const kapazitaetstopfService = require('../utils/kapazitaetstopf.service'); // <-- NEUER Import
const { parseISO } = require('date-fns');
const { GLOBAL_KW1_START_DATE, getGlobalRelativeKW } = require('../utils/date.helpers');


// Hilfsfunktion: Findet oder erstellt einen Kapazitätstopf basierend auf Slot-Kriterien
async function findOrCreateKapazitaetstopf(slotData) {
    //console.log(slotData);
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
        const topfDataToCreate = {
            Abschnitt, Kalenderwoche, Verkehrstag,
            Verkehrsart: slotVerkehrsart, // Nimmt die spezifische Verkehrsart des Slots
            Zeitfenster: passendesZeitfenster,
        };
        try {
            // Hier wird jetzt die zentrale Funktion mit der Verknüpfungslogik aufgerufen!
            topf = await kapazitaetstopfService.createAndLinkKapazitaetstopf(topfDataToCreate);

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
        //console.log(req.body);
        const { von, bis, Abschnitt, Abfahrt, Ankunft, Verkehrstag, Kalenderwoche, Verkehrsart, Grundentgelt, Linienbezeichnung } = req.body;

        // ... (Validierung von Pflichtfeldern und Ankunft > Abfahrt) ...
        if (!Abschnitt) return res.status(400).json({message: 'Abschnitt ist ein Pflichtfeld.'});
        // ...

        const potenziellerTopf = await findOrCreateKapazitaetstopf({ Abschnitt, Kalenderwoche, Verkehrstag, Verkehrsart, Abfahrt });

        const neuerSlot = new Slot({
            von, bis, Abschnitt, Abfahrt, Ankunft, Verkehrstag,
            Kalenderwoche, Verkehrsart, Grundentgelt,
            VerweisAufTopf: potenziellerTopf ? potenziellerTopf._id : null,
            Linienbezeichnung: Linienbezeichnung || undefined // Stelle sicher, dass es undefined ist, wenn leer
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
                                .populate('VerweisAufTopf', 'TopfID TopfName'); // Beispiel für Populate

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

        // Suche nach SlotID_Sprechend oder der technischen _id
        queryConditions.push({ SlotID_Sprechend: slotIdParam });
        if (mongoose.Types.ObjectId.isValid(slotIdParam)) {
            queryConditions.push({ _id: slotIdParam });
        }

        const slot = await Slot.findOne({ $or: queryConditions })
            .populate('VerweisAufTopf', 'TopfID maxKapazitaet') // Lade den zugehörigen Topf und wähle nur das Feld 'TopfID' aus
            .populate('zugewieseneAnfragen', 'AnfrageID_Sprechend Status'); // Lade die Anfragen und wähle nur die 'AnfrageID_Sprechend'


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
        const allowedUpdates = ['von', 'bis', 'Abschnitt', 'Abfahrt', 'Ankunft', 'Verkehrstag', 'Kalenderwoche', 'Verkehrsart', 'Grundentgelt', 'Linienbezeichnung'];
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

// @desc    Erstellt mehrere Slots in einem Massenvorgang
// @route   POST /api/slots/massen-erstellung
exports.createSlotsBulk = async (req, res) => {
    try {
        const { 
            von, bis, Abschnitt, Abfahrt, Ankunft, Verkehrstag, 
            Grundentgelt, Verkehrsart, zeitraumStart, zeitraumEnde,
            Linienbezeichnung 
        } = req.body;

        // 1. Validierung der Eingabedaten
        if (!von || !bis || !Abschnitt || !Abfahrt || !Ankunft || !Verkehrstag || !Grundentgelt || !Verkehrsart || !zeitraumStart || !zeitraumEnde) {
            return res.status(400).json({ message: 'Bitte alle erforderlichen Felder für die Massenerstellung ausfüllen.' });
        }

        const startDate = parseISO(zeitraumStart);
        const endDate = parseISO(zeitraumEnde);

        if (endDate < startDate) {
            return res.status(400).json({ message: 'Das Enddatum darf nicht vor dem Startdatum liegen.' });
        }

        // 2. Ermittle alle relevanten globalen relativen Kalenderwochen
        const startKW = getGlobalRelativeKW(startDate);
        const endKW = getGlobalRelativeKW(endDate);
        if (startKW === null || endKW === null) {
            return res.status(400).json({ message: 'Der angegebene Zeitraum liegt außerhalb des globalen Kalenders.' });
        }

        // Bestimme, welche Verkehrstag-Typen erstellt werden müssen
        let verkehrstageToCreate = [];
        if (Verkehrstag === 'täglich') {
            verkehrstageToCreate = ['Mo-Fr', 'Sa+So'];
        } else {
            // Akzeptiert 'Mo-Fr' oder 'Sa+So' direkt
            verkehrstageToCreate = [Verkehrstag];
        }
        
        const erstellteSlots = [];
        const fehler = [];

        // 3. Schleife durch alle KWs und Erstellung der Slots
        for (let kw = startKW; kw <= endKW; kw++) {
            for (const vt of verkehrstageToCreate) {
                const slotData = {
                    von, bis, Abschnitt, Abfahrt, Ankunft, Verkehrstag: vt,
                    Grundentgelt, Verkehrsart,
                    Kalenderwoche: kw,
                    Linienbezeichnung: Linienbezeichnung || undefined // Stelle sicher, dass es undefined ist, wenn leer
                };

                // Wir nutzen die Logik aus unserem `createSlot`-Controller wieder,
                // indem wir sie in eine Service-Funktion auslagern oder hier nachbilden.
                // Der Einfachheit halber bilden wir sie hier nach.
                
                try {
                    const potenziellerTopf = await findOrCreateKapazitaetstopf({ Abschnitt, Kalenderwoche: kw, Verkehrstag: vt, Verkehrsart, Abfahrt });

                    const neuerSlot = new Slot({ von, bis, Abschnitt, Abfahrt, Ankunft, Verkehrstag: vt,
                                                Kalenderwoche: kw, Verkehrsart, Grundentgelt,
                                                VerweisAufTopf: potenziellerTopf ? potenziellerTopf._id : null,
                                                Linienbezeichnung: Linienbezeichnung || undefined // Stelle sicher, dass es undefined ist, wenn leer
                    });

                    const gespeicherterSlot = await neuerSlot.save(); // pre-save Hook für SlotID_Sprechend läuft

                    // Bidirektionale Verknüpfung: Slot zum (gefundenen oder neu erstellten) Kapazitätstopf hinzufügen
                    if (gespeicherterSlot.VerweisAufTopf) {
                        await updateTopfSlotsAndCapacity(gespeicherterSlot.VerweisAufTopf, gespeicherterSlot._id, 'add');
                    }

                    erstellteSlots.push(gespeicherterSlot);

                } catch (err) {
                    console.error(`Fehler beim Erstellen von Slot für KW ${kw}:`, err);
                    // Wenn ein Slot wegen einer unique-Verletzung (existiert schon) fehlschlägt,
                    // loggen wir den Fehler und machen mit dem nächsten weiter.
                    fehler.push(`KW ${kw}: ${err.message}`);
                }
            }
        }

        res.status(201).json({
            message: `Massen-Erstellung abgeschlossen. ${erstellteSlots.length} Slots erfolgreich erstellt. ${fehler.length} Fehler aufgetreten.`,
            erstellteSlots,
            fehler
        });

    } catch (error) {
        console.error('Schwerwiegender Fehler bei der Massenerstellung von Slots:', error);
        res.status(500).json({ message: 'Serverfehler bei der Massenerstellung.' });
    }
};

// @desc    Liefert eine aggregierte Zusammenfassung aller Slots
// @route   GET /api/slots/summary
exports.getSlotSummary = async (req, res) => {
    try {
        const summary = await Slot.aggregate([
            // Stufe 1: Berücksichtige nur Slots, die eine Linienbezeichnung haben.
            {
                $match: {
                    Linienbezeichnung: { $exists: true, $ne: null }
                }
            },
            // Stufe 2: Füge ein temporäres Feld für den Belegungsstatus hinzu.
            {
                $addFields: {
                    belegungsStatus: {
                        $switch: {
                            branches: [
                                { case: { $eq: [{ $size: "$zugewieseneAnfragen" }, 0] }, then: "frei" },
                                { case: { $eq: [{ $size: "$zugewieseneAnfragen" }, 1] }, then: "einfach_belegt" }
                            ],
                            default: "mehrfach_belegt"
                        }
                    }
                }
            },
            // Stufe 3: Gruppiere nach dem zusammengesetzten Schlüssel.
            {
                $group: {
                    _id: {
                        linie: "$Linienbezeichnung",
                        abschnitt: "$Abschnitt",
                        verkehrsart: "$Verkehrsart",
                        verkehrstag: "$Verkehrstag"
                    },
                    anzahlSlots: { $sum: 1 },
                    minKW: { $min: "$Kalenderwoche" },
                    maxKW: { $max: "$Kalenderwoche" },
                    anzahlFrei: { $sum: { $cond: [{ $eq: ["$belegungsStatus", "frei"] }, 1, 0] } },
                    anzahlEinfachBelegt: { $sum: { $cond: [{ $eq: ["$belegungsStatus", "einfach_belegt"] }, 1, 0] } },
                    anzahlMehrfachBelegt: { $sum: { $cond: [{ $eq: ["$belegungsStatus", "mehrfach_belegt"] }, 1, 0] } }
                }
            },
            // Stufe 4: Formatiere die Ausgabe.
            {
                $project: {
                    _id: 0,
                    linie: "$_id.linie",
                    abschnitt: "$_id.abschnitt",
                    verkehrsart: "$_id.verkehrsart",
                    verkehrstag: "$_id.verkehrstag",
                    anzahlSlots: 1,
                    minKW: 1,
                    maxKW: 1,
                    belegung: { // Gruppiere die Belegungszahlen in ein Objekt
                        frei: "$anzahlFrei",
                        einfach: "$anzahlEinfachBelegt",
                        mehrfach: "$anzahlMehrfachBelegt"
                    }
                }
            },
            // Stufe 5: Sortiere das Endergebnis.
            {
                $sort: {
                    linie: 1,
                    abschnitt: 1,
                    verkehrstag: 1
                }
            }
        ]);

        res.status(200).json({
            message: 'Zusammenfassung der Slots erfolgreich abgerufen.',
            data: summary
        });

    } catch (error) {
        console.error('Fehler bei der Erstellung der Slot-Zusammenfassung:', error);
        res.status(500).json({ message: 'Serverfehler bei der Erstellung der Zusammenfassung.' });
    }
};

// @desc    Liefert eine aggregierte Zusammenfassung von Slots nach Abschnitt und Verkehrstagen
// @route   GET /api/slots/counter
exports.getSlotCounterSummary = async (req, res) => {
    try {
        const summary = await Slot.aggregate([
            // Stufe 1: Gruppiere nach den definierenden Eigenschaften eines Slot-Musters
            {
                $group: {
                    _id: {
                        von: "$von",
                        bis: "$bis",
                        abfahrt: "$Abfahrt",
                        ankunft: "$Ankunft",
                        verkehrsart: "$Verkehrsart",
                        abschnitt: "$Abschnitt"
                    },
                    // Sammle für jedes Muster die Kalenderwoche und den Verkehrstag
                    kws: { $push: { kw: "$Kalenderwoche", vt: "$Verkehrstag" } }
                }
            },
            // Stufe 2: Formatiere das Ergebnis und trenne die KWs nach Verkehrstag
            {
                $project: {
                    _id: 0, // Die technische _id entfernen
                    slotMuster: "$_id", // Das Gruppierungsobjekt umbenennen
                    kwsMoFr: { // Filtere alle KWs für Mo-Fr
                        $filter: { input: "$kws", as: "item", cond: { $eq: ["$$item.vt", "Mo-Fr"] } }
                    },
                    kwsSaSo: { // Filtere alle KWs für Sa+So
                        $filter: { input: "$kws", as: "item", cond: { $eq: ["$$item.vt", "Sa+So"] } }
                    }
                }
            },
            {
                $project: {
                    slotMuster: 1,
                    anzahlMoFr: { $size: "$kwsMoFr" },
                    kwsMoFr: "$kwsMoFr.kw", // Extrahiere nur die KW-Nummern
                    anzahlSaSo: { $size: "$kwsSaSo" },
                    kwsSaSo: "$kwsSaSo.kw" // Extrahiere nur die KW-Nummern
                }
            },
            // Stufe 3: Gruppiere das Ergebnis nach Abschnitt für die Tabellen im Frontend
            {
                $group: {
                    _id: "$slotMuster.abschnitt",
                    slotTypen: { $push: "$$ROOT" } // Füge das ganze Dokument der Zeile zum Array hinzu
                }
            },
            // --- ZWISCHENSTUFEN FÜR DIE SORTIERUNG ---
            // Stufe 3a: "Entpacke" das slotTypen-Array, um auf die inneren Werte zugreifen zu können
            { $unwind: "$slotTypen" },

            // Stufe 3b: Sortiere die entpackten Dokumente nach der Abfahrtszeit
            { 
                $sort: {
                    "slotTypen.slotMuster.abfahrt.stunde": 1,
                    "slotTypen.slotMuster.abfahrt.minute": 1
                } 
            },

            // Stufe 3c: Gruppiere die jetzt sortierten Dokumente wieder nach Abschnitt
            {
                $group: {
                    _id: "$_id", // Der Abschnittsname ist jetzt in der _id
                    slotTypen: { $push: "$slotTypen" } // Füge die sortierten slotTypen wieder zu einem Array zusammen
                }
            },
            // Stufe 4: Finale Formatierung und Sortierung
            {
                $project: {
                    _id: 0,
                    abschnitt: "$_id",
                    slotTypen: 1
                }
            },
            {
                $sort: { abschnitt: 1 }
            }
        ]);

        res.status(200).json({
            message: 'Slot-Zusammenfassung nach Pfad erfolgreich abgerufen.',
            data: summary
        });

    } catch (error) {
        console.error('Fehler bei der Erstellung der Slot-Zusammenfassung:', error);
        res.status(500).json({ message: 'Serverfehler bei der Erstellung der Zusammenfassung.' });
    }
};