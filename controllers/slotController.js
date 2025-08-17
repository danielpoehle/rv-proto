// slot-buchungs-app/controllers/slotController.js
const mongoose = require('mongoose');
const {Slot} = require('../models/Slot');
const Kapazitaetstopf = require('../models/Kapazitaetstopf');
const { parseISO } = require('date-fns');
const { GLOBAL_KW1_START_DATE, getGlobalRelativeKW } = require('../utils/date.helpers');
const slotService = require('../utils/slot.service');
const { findOrCreateKapazitaetstopf, updateTopfSlotsAndCapacity } = require('../utils/slotController.helpers');




// @desc    Erstellt einen neuen Infrastruktur-Slot
// @route   POST /api/slots
exports.createSlot = async (req, res) => {    
        const { 
            slotTyp, // NEU: 'TAG' oder 'NACHT'
            von, bis, Abschnitt, Verkehrstag, Grundentgelt, Linienbezeichnung,
            Kalenderwoche,
            // Tag-spezifisch:
            Abfahrt, Ankunft, Verkehrsart,
            // Nacht-spezifisch:
            Zeitfenster, Mindestfahrzeit, Maximalfahrzeit
        } = req.body;

        //console.log(req.body);

        //0. Validierung ob slotTyp gesetzt wurde
        if(!slotTyp){
            return res.status(400).json({ message: 'Bitte slotTyp setzen.' });
        }

        // 1. Validierung der Eingabedaten
        if(slotTyp === 'TAG'){
            if (!von || !bis || !Abschnitt || !Abfahrt || !Ankunft || !Verkehrstag || !Grundentgelt || !Verkehrsart || !Kalenderwoche ) {                
                return res.status(400).json({ message: 'Bitte alle erforderlichen Felder für die Massenerstellung (Tag) ausfüllen.' });
            }
        }else{ // Nacht-Slot
            if (!von || !bis || !Abschnitt || !Zeitfenster || !Mindestfahrzeit || !Verkehrstag || !Grundentgelt || !Maximalfahrzeit || !Kalenderwoche ) {
                return res.status(400).json({ message: 'Bitte alle erforderlichen Felder für die Massenerstellung (Nacht) ausfüllen.' });
            }
        }        

        if(!['Mo-Fr', 'Sa+So'].includes(Verkehrstag)){
            return res.status(400).json({ message: 'Verkehrstag Mo-Fr oder Sa+So ist nur zulässig' });
        }

        const slotData = {
                    slotTyp, von, bis, Abschnitt, Grundentgelt, 
                    Linienbezeichnung: Linienbezeichnung || undefined,
                    Kalenderwoche,
                    Verkehrstag,
                    // Füge typspezifische Daten hinzu
                    ...(slotTyp === 'NACHT'
                        ? { Zeitfenster, Mindestfahrzeit, Maximalfahrzeit }
                        : { Abfahrt, Ankunft, Verkehrsart }
                    )
                };

        try {
            // Rufe die zentrale Service-Funktion auf
            const erstellterSlot = await slotService.createSingleSlot(slotData);   
            res.status(201).json({
            message: 'Slot erfolgreich erstellt und Kapazitätstopf-Verknüpfung hergestellt/geprüft.',
            data: erstellterSlot
        });                        

        } catch (err) {
            console.error(`Fehler beim Erstellen von ${slotTyp}-Slot für KW ${Kalenderwoche} / VT ${Verkehrstag}:`, err);
            // Prüfe auf spezifische Fehler, z.B. wenn der Slot schon existiert (unique-Verletzung)
            if (err.code === 11000) {
                return res.status(409).json({ // 409 Conflict
                    message: 'Ein Slot mit dieser sprechenden ID existiert bereits.',
                    errorDetails: err.message
                });
            }
            
            // Allgemeiner Serverfehler
            res.status(500).json({
                message: 'Ein interner Fehler ist beim Erstellen des Slots aufgetreten.',
                errorDetails: err.message
            });                            
        }    
        //console.log("finished createSlot");     
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
            sortOptions['Abschnitt'] = 1;
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
                slotTyp: slot.slotTyp,
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

        // 2. Aufräumen: Entferne die Slots aus den Kapazitätstöpfen
        // WICHTIG: .deleteMany() löst KEINE Mongoose-Hooks aus! Wir müssen die Logik aus dem
        // pre('deleteOne')-Hook hier manuell ausführen.
        const toepfeToUpdate = await Kapazitaetstopf.find({ ListeDerSlots: { $in: [slot._id] } });
        for (const topf of toepfeToUpdate) {
            topf.ListeDerSlots.pull(slot._id);
            topf.maxKapazitaet = Math.floor(0.7 * topf.ListeDerSlots.length);
            await topf.save();
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

// @desc    Erstellt mehrere Slots in einem Massenvorgang (Tag oder Nacht)
// @route   POST /api/slots/massen-erstellung
exports.createSlotsBulk = async (req, res) => {
    try {
        const { 
            slotTyp, // NEU: 'TAG' oder 'NACHT'
            von, bis, Abschnitt, Verkehrstag, Grundentgelt, Linienbezeichnung,
            zeitraumStart, zeitraumEnde,
            // Tag-spezifisch:
            Abfahrt, Ankunft, Verkehrsart,
            // Nacht-spezifisch:
            Zeitfenster, Mindestfahrzeit, Maximalfahrzeit
        } = req.body;

        if(!slotTyp){
            return res.status(400).json({ message: 'Slot-Typ fehlt.' });
        }

        // 1. Validierung der Eingabedaten
        if(slotTyp === 'TAG'){
            if (!von || !bis || !Abschnitt || !Abfahrt || !Ankunft || !Verkehrstag || !Grundentgelt || !Verkehrsart || !zeitraumStart || !zeitraumEnde) {
                return res.status(400).json({ message: 'Bitte alle erforderlichen Felder für die Massenerstellung (Tag) ausfüllen.' });
            }
        }else{ // Nacht-Slot
            if (!von || !bis || !Abschnitt || !Zeitfenster || !Mindestfahrzeit || !Verkehrstag || !Grundentgelt || !Maximalfahrzeit || !zeitraumStart || !zeitraumEnde) {
                return res.status(400).json({ message: 'Bitte alle erforderlichen Felder für die Massenerstellung (Nacht) ausfüllen.' });
            }
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
                    slotTyp, von, bis, Abschnitt, Grundentgelt, 
                    Linienbezeichnung: Linienbezeichnung || undefined,
                    Kalenderwoche: kw,
                    Verkehrstag: vt,
                    // Füge typspezifische Daten hinzu
                    ...(slotTyp === 'NACHT'
                        ? { Zeitfenster, Mindestfahrzeit, Maximalfahrzeit }
                        : { Abfahrt, Ankunft, Verkehrsart }
                    )
                };                
                
                try {
                    // Rufe die zentrale Service-Funktion auf
                    const erstellterSlot = await slotService.createSingleSlot(slotData);
                    erstellteSlots.push(erstellterSlot);

                } catch (err) {
                    console.error(`Fehler beim Erstellen von ${slotTyp}-Slot für KW ${kw} / VT ${vt}:`, err);
                    // Wenn ein Slot wegen einer unique-Verletzung (existiert schon) fehlschlägt,
                    // loggen wir den Fehler und machen mit dem nächsten weiter.
                    fehler.push(`${slotTyp}-Slot KW ${kw} VT ${vt}: ${err.message}`);
                }
            }
        }

        res.status(201).json({
            message: `Massen-Erstellung abgeschlossen. ${erstellteSlots.length} ${slotTyp}-Slots erfolgreich erstellt. ${fehler.length} Fehler aufgetreten.`,
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
                        abschnitt: "$Abschnitt",
                        linie: "$Linienbezeichnung",
                        slotTyp: "$slotTyp",
                        zeitfenster: "$Zeitfenster"
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

// @desc    Ruft alle Slots ab, die zu einer gemeinsamen Linie mit einer bestimmmten Abfahrtzeit auf einem Abschnitt gehören
// @route   GET /api/slots/by-muster
exports.getSlotsByMuster = async (req, res) => {
    try {
        const { von, bis, abfahrtStunde, abfahrtMinute, ankunftStunde, ankunftMinute, verkehrsart, abschnitt, slotTyp, zeitfenster } = req.query;

        const istTagSlot = slotTyp === 'TAG';
        // Baue eine exakte Übereinstimmungsabfrage
        const baseParams = {
                            von, bis, slotTyp, 'Verkehrsart': verkehrsart, 'Abschnitt': abschnitt,
                           };

        const matchQuery = istTagSlot ? {     
                                            ...baseParams,
                                            'Abfahrt.stunde': parseInt(abfahrtStunde),
                                            'Abfahrt.minute': parseInt(abfahrtMinute),
                                            'Ankunft.stunde': parseInt(ankunftStunde),
                                            'Ankunft.minute': parseInt(ankunftMinute),
                                        }: {
                                            ...baseParams,
                                            'Zeitfenster': zeitfenster,
                                        };

        //console.log('DEBUG: Suche Slots mit folgender exakter Query:', matchQuery);


        const slots = await Slot.find(matchQuery)
                                .select('SlotID_Sprechend zugewieseneAnfragen Kalenderwoche Verkehrstag')
                                .sort({ Kalenderwoche: 1, Verkehrstag: 1 });

        //console.log(`DEBUG: ${slots.length} Slots gefunden.`);

        res.status(200).json({ data: slots });
    } catch (error) {
        res.status(500).json({ message: 'Serverfehler beim Abrufen der Slots nach Muster.' });
    }
};

// @desc    Löscht mehrere Slots basierend auf den übergebenden IDs der Slots
// @route   POST /api/slots/bulk-delete
exports.deleteSlotsBulk = async (req, res) => {
    const { slotIdsToDelete } = req.body;

    if (!slotIdsToDelete || !Array.isArray(slotIdsToDelete) || slotIdsToDelete.length === 0) {
        return res.status(400).json({ message: 'Ein Array von slotIdsToDelete ist erforderlich.' });
    }

    try {
        // 1. Sicherheitsprüfung: Stelle sicher, dass ALLE zu löschenden Slots keine zugewiesenen Anfragen haben.
        const slotsToVerify = await Slot.find({ _id: { $in: slotIdsToDelete } }).select('zugewieseneAnfragen SlotID_Sprechend');

        if(slotsToVerify.length !== slotIdsToDelete.length) {
            return res.status(404).json({ message: 'Einige der zu löschenden Slots wurden nicht gefunden.' });
        }
        
        const belegteSlots = slotsToVerify.filter(s => s.zugewieseneAnfragen && s.zugewieseneAnfragen.length > 0);
        if (belegteSlots.length > 0) {
            return res.status(409).json({
                message: 'Löschen nicht möglich. Mindestens ein ausgewählter Slot ist noch Anfragen zugewiesen.',
                details: belegteSlots.map(s => s.SlotID_Sprechend)
            });
        }
        
        // 2. Aufräumen: Entferne die Slots aus den Kapazitätstöpfen
        // WICHTIG: .deleteMany() löst KEINE Mongoose-Hooks aus! Wir müssen die Logik aus dem
        // pre('deleteOne')-Hook hier manuell ausführen.
        const toepfeToUpdate = await Kapazitaetstopf.find({ ListeDerSlots: { $in: slotIdsToDelete } });
        for (const topf of toepfeToUpdate) {
            topf.ListeDerSlots.pull(...slotIdsToDelete);
            topf.maxKapazitaet = Math.floor(0.7 * topf.ListeDerSlots.length);
            await topf.save();
        }
        
        // 3. Führe die Massenlöschung durch
        const deleteResult = await Slot.deleteMany({ _id: { $in: slotIdsToDelete } });

        res.status(200).json({
            message: `${deleteResult.deletedCount} Slots erfolgreich gelöscht.`,
            data: { deletedCount: deleteResult.deletedCount }
        });
    } catch (error) {
        console.error('Fehler beim Massenlöschen von Slots:', error);
        res.status(500).json({ message: 'Serverfehler beim Massenlöschen.' });
    }
};

// @desc    Migriert alte Slot-Dokumente zum neuen Discriminator-Schema
// @route   POST /api/slots/migrate-to-discriminator
exports.migrateAlteSlots = async (req, res) => {
    try {
        console.log("Starte Migration für alte Slot-Dokumente mit direkter Methode...");

        // Schritt 1: Definiere ein temporäres, einfaches Schema, das die ALTEN Dokumente beschreibt.
        // Wichtig: KEIN discriminatorKey hier!
        const SimpleSlotSchema = new mongoose.Schema({
            Abfahrt: Object, // Wir brauchen nur die Existenz dieses Feldes für den Filter
            // Wir müssen nicht alle Felder definieren, nur die, die wir für die Operation brauchen.
        }, { 
            strict: false, // Erlaube andere Felder, die im Schema nicht definiert sind
            collection: 'slots' // Sage Mongoose explizit, welche Collection es verwenden soll
        });

        // Schritt 2: Erstelle ein temporäres Mongoose-Modell.
        // Wir prüfen, ob es schon existiert, um Fehler bei schnellen wiederholten Aufrufen zu vermeiden.
        const TempSlotModel = mongoose.models.TempSlotForMigration || mongoose.model('TempSlotForMigration', SimpleSlotSchema);

        // Schritt 3: Definiere Filter und Update wie zuvor.
        const filter = {
            slotTyp: { $exists: false },
            Abfahrt: { $exists: true }
        };
        const update = {
            $set: { slotTyp: 'TAG' }
        };

        // Schritt 4: Führe updateMany auf dem TEMPORÄREN Modell aus.
        const result = await TempSlotModel.updateMany(filter, update);

        console.log("Migration abgeschlossen:", result);

        res.status(200).json({
            message: 'Slot-Migration erfolgreich abgeschlossen.',
            summary: {
                gefundeneDokumente: result.matchedCount,
                aktualisierteDokumente: result.modifiedCount
            }
        });

    } catch (error) {
        console.error('Fehler bei der Slot-Migration:', error);
        res.status(500).json({ message: 'Serverfehler bei der Migration.' });
    }
};