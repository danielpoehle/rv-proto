// slot-buchungs-app/controllers/slotController.js
const mongoose = require('mongoose');
const { Slot, TagesSlot, NachtSlot } = require('../models/Slot');
const Kapazitaetstopf = require('../models/Kapazitaetstopf');
const { parseISO } = require('date-fns');
const { GLOBAL_KW1_START_DATE, getGlobalRelativeKW } = require('../utils/date.helpers');
const slotService = require('../utils/slot.service');
const { findOrCreateKapazitaetstopf, updateTopfSlotsAndCapacity } = require('../utils/slotController.helpers');




// @desc    Erstellt einen neuen Infrastruktur-Slot
// @route   POST /api/slots
exports.createSlot = async (req, res) => {  
    // req.body = {
    //      "elternSlotTyp": "TAG",
    //      "Linienbezeichnung": "S1",
    //      "Verkehrstag": "Mo-Fr",
    //      "Kalenderwoche": 5,
    //      "alternativen": [
    //           {
    //              "von": "A",
    //              "bis": "B",
    //              "Abschnitt": "S1-AB",
    //              "Grundentgelt": 10,
    //              "Abfahrt": { "stunde": 8, "minute": 0 },
    //              "Ankunft": { "stunde": 8, "minute": 10 },
    //              "Verkehrsart": "SPNV"
    //            },
    //            {
    //              "von": "A",
    //              "bis": "C",
    //              "Abschnitt": "S1-AC",
    //              "Grundentgelt": 12,
    //              "Abfahrt": { "stunde": 8, "minute": 0 },
    //              "Ankunft": { "stunde": 8, "minute": 12 },
    //              "Verkehrsart": "SPNV"
    //            }
    //      ]
    // } 
    // Der Request-Body entspricht jetzt der neuen Struktur
    const gruppenData = req.body;
    try {       
        //console.log(gruppenData);
        
        // Validierung könnte hier stattfinden
        if (!gruppenData.elternSlotTyp || !gruppenData.alternativen) {
            return res.status(400).json({ message: 'Payload muss elternSlotTyp und ein Array für die KIND-Slots enthalten.' });
        }

        const erstellteGruppe = await slotService.createSlotGruppe(gruppenData);
        
        res.status(201).json({
            message: `Erstellen von ${gruppenData.elternSlotTyp}-Slot für KW ${gruppenData.Kalenderwoche} / VT ${gruppenData.Verkehrstag} erfolgreich erstellt und Kapazitätstopf-Verknüpfung hergestellt/geprüft.`,
            data: erstellteGruppe
        });
    } catch (err) {
            console.error(`Fehler beim Erstellen von ${gruppenData.elternSlotTyp}-Slot für KW ${gruppenData.Kalenderwoche} / VT ${gruppenData.Verkehrstag}:`, err);
            // Prüfe auf spezifische Fehler, z.B. wenn der Slot schon existiert (unique-Verletzung)
            if (err.code === 11000) {
                return res.status(409).json({ // 409 Conflict
                    message: `Fehler beim Erstellen von ${gruppenData.elternSlotTyp}-Slot für KW ${gruppenData.Kalenderwoche} / VT ${gruppenData.Verkehrstag}: Ein Slot mit dieser sprechenden ID existiert bereits.`,
                    errorDetails: err.message
                });
            }
            
            // Allgemeiner Serverfehler
            res.status(500).json({
                message: `Fehler beim Erstellen von ${gruppenData.elternSlotTyp}-Slot für KW ${gruppenData.Kalenderwoche} / VT ${gruppenData.Verkehrstag}: Interner Serverfehler.`,
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
        let filter = { slotStrukturTyp: 'KIND' };
        //let filter = {  };
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
        if (mongoose.Types.ObjectId.isValid(slotIdParam)) {
            queryConditions.push({ _id: slotIdParam });
        }
        if (slotIdParam) { // Füge Suche nach sprechender ID hinzu
            queryConditions.push({ SlotID_Sprechend: slotIdParam });
        }

        if (queryConditions.length === 0) {
             return res.status(400).json({ message: 'Gültige Slot-ID erforderlich.' });
        }

        // Schritt 1: Finde den Slot, aber populiere noch nichts.
        const slot = await Slot.findOne({ $or: queryConditions });

        if (!slot) {
            return res.status(404).json({ message: 'Slot nicht gefunden.' });
        }

        console.log(slot);

        // Schritt 2: Führe die korrekte Population basierend auf dem Typ durch.
        if (slot.slotStrukturTyp === 'KIND') {
            // Für einen KIND-Slot: Populiere den Eltern-Slot, und darin den Verweis auf den Topf.
            await slot.populate({
                path: 'gabelElternSlot',
                select: 'VerweisAufTopf SlotID_Sprechend',
                populate: {
                    path: 'VerweisAufTopf',
                    model: 'Kapazitaetstopf',
                    select: 'TopfID maxKapazitaet'
                }
            });
        } else { // Es ist ein ELTERN-Slot
            // Für einen ELTERN-Slot: Populiere direkt seinen eigenen Verweis auf den Topf.
            await slot.populate('VerweisAufTopf', 'TopfID maxKapazitaet');
        }

        // Schritt 3: Populiere die zugewiesenen Anfragen (dies ist für beide Typen gleich).
        await slot.populate('zugewieseneAnfragen', 'AnfrageID_Sprechend Status');

        console.log(slot);

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

// @desc    Aktualisiert einen einzelnen, fahrbaren KIND-Slot
// @route   PUT /api/slots/:slotId
exports.updateSlot = async (req, res) => {
    try {
        const slotIdParam = req.params.slotId; // Dies ist die ID des KIND-Slots
        const updates = req.body || {};

        // 1. Finde den zu aktualisierenden KIND-Slot
        const kindSlot = await Slot.findById(slotIdParam);

        if (!kindSlot || kindSlot.slotStrukturTyp !== 'KIND') {
            return res.status(404).json({ message: 'Fahrbarer Slot (Kind-Slot) nicht gefunden.' });
        }
        
        // Lade das zugehörige Eltern-Dokument
        const elternSlot = await Slot.findById(kindSlot.gabelElternSlot);
        if (!elternSlot) {
            return res.status(500).json({ message: `Inkonsistente Daten: Kind-Slot ${kindSlot._id} hat keinen gültigen Eltern-Slot.`});
        }

        // Erlaube das Update nur, wenn der Eltern-Slot genau ein Kind hat (also kein echter Gabel-Slot ist).
        if (elternSlot.gabelAlternativen.length !== 1) {
            return res.status(409).json({ // 409 Conflict
                message: 'Update nicht möglich: Dieser Slot ist Teil einer Gabelung mit mehreren Alternativen. Um Gabel-Slots zu ändern, müssen sie gelöscht und als neue Gruppe angelegt werden.'
            });
        }
        
        const alterVerweisAufTopf = elternSlot.VerweisAufTopf ? elternSlot.VerweisAufTopf : null;

        // 2. Wende die Updates auf das KIND-Dokument an
        const allowedUpdates = ['von', 'bis', 'Abschnitt','Abfahrt', 'Ankunft', 'Verkehrsart', 'Grundentgelt', 'Linienbezeichnung', 'Zeitfenster', 'Mindestfahrzeit', 'Maximalfahrzeit'];
        let relevanteFelderGeaendert = false;
        
        for (const key in updates) {
            if (allowedUpdates.includes(key)) {
                // ... (deine Logik zum Zuweisen der Updates zum `kindSlot`-Objekt)
                kindSlot[key] = updates[key];
                kindSlot.markModified(key);
                if (['Abschnitt', 'Kalenderwoche', 'Verkehrstag', 'Verkehrsart', 'Abfahrt', 'Zeitfenster'].includes(key)) {
                    relevanteFelderGeaendert = true;
                }
            }
        }
        // Aktualisiere auch die gemeinsamen Felder am Eltern-Teil, falls sie sich ändern
        if (updates.Linienbezeichnung !== undefined) elternSlot.Linienbezeichnung = updates.Linienbezeichnung;
        if (updates.Abschnitt !== undefined) {elternSlot.Abschnitt = updates.Abschnitt; relevanteFelderGeaendert = true;}
        if (updates.Kalenderwoche !== undefined) {elternSlot.Kalenderwoche = updates.Kalenderwoche; relevanteFelderGeaendert = true;}
        if (updates.Verkehrstag !== undefined) {elternSlot.Verkehrstag = updates.Verkehrstag; relevanteFelderGeaendert = true;}        

        // 3. Wenn sich für die Topf-Zuordnung relevante Felder geändert haben, neuen Topf für ELTERN bestimmen
        if (relevanteFelderGeaendert) {
            const topfSuchDaten = {
                Abschnitt: elternSlot.Abschnitt,
                Kalenderwoche: elternSlot.Kalenderwoche,
                Verkehrstag: elternSlot.Verkehrstag,
                // Typspezifische Daten vom Kind übernehmen
                slotTyp: kindSlot.slotTyp,
                Verkehrsart: kindSlot.Verkehrsart,
                Abfahrt: kindSlot.Abfahrt,
                Zeitfenster: kindSlot.Zeitfenster
            };

            const potenziellerNeuerTopf = await findOrCreateKapazitaetstopf(topfSuchDaten); // Nutze die Daten des kombinierten Objekts zur Findung
            
            // Aktualisiere den Verweis im ELTERN-Dokument
            elternSlot.VerweisAufTopf = potenziellerNeuerTopf ? potenziellerNeuerTopf._id : null;
        }

        // 4. Speichere beide Dokumente (Kind und Eltern)
        // Die pre-save Hooks laufen und generieren ggf. neue sprechende IDs
        const aktualisierterKindSlot = await kindSlot.save();
        await elternSlot.save();

        // 5. Bidirektionale Verknüpfung in den Töpfen managen
        const neuerVerweisAufTopf = elternSlot.VerweisAufTopf ? elternSlot.VerweisAufTopf : null;
        
        // Prüfen, ob sich der Topf-Verweis des ELTERN-Slots geändert hat
        const hatTopfSichGeaendert = alterVerweisAufTopf?.toString() !== neuerVerweisAufTopf?.toString();

        if (hatTopfSichGeaendert) {
            // Entferne den ELTERN-Slot aus dem alten Topf
            if (alterVerweisAufTopf) {
                await updateTopfSlotsAndCapacity(alterVerweisAufTopf, elternSlot._id, 'remove');
            }
            // Füge den ELTERN-Slot zum neuen Topf hinzu
            if (neuerVerweisAufTopf) {
                await updateTopfSlotsAndCapacity(neuerVerweisAufTopf, elternSlot._id, 'add');
            }
        }

        res.status(200).json({
            message: 'Slot erfolgreich aktualisiert, Kapazitätstopf-Verknüpfung geprüft.',
            data: aktualisierterKindSlot
        });

    } catch (error) {
        console.error('Fehler beim Aktualisieren des Slots:', error);
        res.status(500).json({ message: 'Serverfehler beim Aktualisieren des Slots.' });
    }
};

// @desc    Löscht einen Slot
// @route   DELETE /api/slots/:slotId
exports.deleteSlot = async (req, res) => {
    try {
        const slotIdParam = req.params.slotId;

        // 1. Finde den initialen Slot, der übergeben wurde zum Löschen
        const initialSlot = await Slot.findOne({ 
            $or: [{ _id: mongoose.Types.ObjectId.isValid(slotIdParam) ? slotIdParam : null }, { SlotID_Sprechend: slotIdParam }]
        });

        if (!initialSlot) {
            return res.status(404).json({ message: `Slot mit der ID ${slotIdParam} nicht gefunden.` });
        }

        // 2. Finde die gesamte zu löschende "Familie" (Eltern + alle Kinder)
        let elternSlot;
        if (initialSlot.slotStrukturTyp === 'KIND') {
            elternSlot = await Slot.findById(initialSlot.gabelElternSlot);
        } else { // Es ist bereits der Eltern-Slot
            elternSlot = initialSlot;
        }

        if (!elternSlot) {
            // Dies ist ein inkonsistenter Zustand, wir löschen sicherheitshalber nur das gefundene Kind
            await initialSlot.deleteOne();
            return res.status(200).json({ message: 'Kind-Slot ohne Elternteil gelöscht. Daten waren inkonsistent.' });
        }
        
        // Sammle die IDs von Eltern und allen Kindern
        const slotIdsToDelete = [elternSlot._id, ...elternSlot.gabelAlternativen];


        // 3. Sicherheitsprüfung: Prüfe, ob IRGENDEIN Slot der Familie noch belegt ist
        const belegteSlots = await Slot.find({
            _id: { $in: slotIdsToDelete },
            'zugewieseneAnfragen.0': { $exists: true } // Effiziente Prüfung, ob Array nicht leer ist
        }).limit(1);

        if (belegteSlots.length > 0) {
            return res.status(409).json({ // 409 Conflict
                message: 'Slot-Familie kann nicht gelöscht werden, da mindestens ein Slot noch von Anfragen belegt ist.',
            });
        }

        // 4. Aufräumen: Entferne den ELTERN-Slot aus dem Kapazitätstopf
        if (elternSlot.VerweisAufTopf) {
            const topf = await Kapazitaetstopf.findById(elternSlot.VerweisAufTopf);
            if (topf) {
                topf.ListeDerSlots.pull(elternSlot._id);
                topf.maxKapazitaet = Math.floor(0.7 * topf.ListeDerSlots.length);
                await topf.save();
                console.log(`Eltern-Slot ${elternSlot._id} aus Kapazitätstopf ${topf._id} entfernt.`);
            }
        }

        // 5. Führe die Massenlöschung für die gesamte Familie durch
        const deleteResult = await Slot.deleteMany({ _id: { $in: slotIdsToDelete } });


        res.status(200).json({
            message: `Slot-Familie erfolgreich gelöscht. ${deleteResult.deletedCount} Dokumente wurden entfernt.`,
            data: { 
                geloeschteElternId: elternSlot._id,
                geloeschteKinderIds: elternSlot.gabelAlternativen,
                anzahlGeloescht: deleteResult.deletedCount
            }
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
        
        const { zeitraumStart, zeitraumEnde, ...musterDaten } = req.body;
        // musterDaten enthält jetzt elternSlotTyp, Linienbezeichnung, Verkehrstag und das `alternativen`-Array


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
        if (musterDaten.Verkehrstag === 'täglich') {
            verkehrstageToCreate = ['Mo-Fr', 'Sa+So'];
        } else {
            // Akzeptiert 'Mo-Fr' oder 'Sa+So' direkt
            verkehrstageToCreate = [musterDaten.Verkehrstag];
        }
        
        const erstellteSlots = [];
        const fehler = [];

        // 3. Schleife durch alle KWs und Erstellung der Slots
        for (let kw = startKW; kw <= endKW; kw++) {
            for (const vt of verkehrstageToCreate) {

                const gruppenDataFuerIteration = {
                    ...musterDaten,
                    Kalenderwoche: kw,
                    Verkehrstag: vt
                };         
                
                try {
                    // Rufe die zentrale Service-Funktion auf
                    const erstellterSlot = await slotService.createSlotGruppe(gruppenDataFuerIteration);
                    erstellteSlots.push(erstellterSlot);

                } catch (err) {
                    console.error(`Fehler beim Erstellen von ${musterDaten.elternSlotTyp}-Slot für KW ${kw} / VT ${vt}:`, err);
                    // Wenn ein Slot wegen einer unique-Verletzung (existiert schon) fehlschlägt,
                    // loggen wir den Fehler und machen mit dem nächsten weiter.
                    fehler.push(`${musterDaten.elternSlotTyp}-Slot KW ${kw} VT ${vt}: ${err.message}`);
                }
            }
        }

        res.status(201).json({
            message: `Massen-Erstellung abgeschlossen. ${erstellteSlots.length} ${musterDaten.elternSlotTyp}-Slots erfolgreich erstellt. ${fehler.length} Fehler aufgetreten.`,
            erstellteSlots,
            fehler
        });

    } catch (error) {
        console.error(`Fehler bei der Massenerstellung von ${musterDaten.elternSlotTyp}-Slots: `, error);
        res.status(500).json({ message: `Fehler bei der Massenerstellung von ${musterDaten.elternSlotTyp}-Slots: ${error}` });
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
                    slotStrukturTyp: 'KIND', 
                    Linienbezeichnung: { $exists: true, $ne: null, $ne: '' }
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
            
            // Stufe 0: Filtere zuerst nur die KIND-Slots heraus.
            {
                $match: {
                    slotStrukturTyp: 'KIND'
                }
            },
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

// @desc    Migriert alte Slot-Dokumente zum neuen Discriminator-Schema und zur neuen Eltern-Kind-Struktur
// @route   POST /api/slots/migrate-to-discriminator
exports.migrateAlteSlots = async (req, res) => {
    try {
        console.log("Starte Migration für alte Slot-Dokumente zur Eltern-Kind-Struktur...");
        let migratedCount = 0;

        // Schritt 1.1: Definiere ein temporäres, einfaches Schema, das die ALTEN Dokumente beschreibt.
        // Wichtig: KEIN discriminatorKey hier!
        const SimpleSlotSchema = new mongoose.Schema({
            Abfahrt: Object, // Wir brauchen nur die Existenz dieses Feldes für den Filter
            // Wir müssen nicht alle Felder definieren, nur die, die wir für die Operation brauchen.
        }, { 
            strict: false, // Erlaube andere Felder, die im Schema nicht definiert sind
            collection: 'slots' // Sage Mongoose explizit, welche Collection es verwenden soll
        });

        // Schritt 1.2: Erstelle ein temporäres Mongoose-Modell.
        // Wir prüfen, ob es schon existiert, um Fehler bei schnellen wiederholten Aufrufen zu vermeiden.
        const TempSlotModel = mongoose.models.TempSlotForMigration || mongoose.model('TempSlotForMigration', SimpleSlotSchema);

        // Schritt 1.3: Definiere Filter und Update wie zuvor.
        const filter = {
            slotTyp: { $exists: false },
            Abfahrt: { $exists: true }
        };
        const update = {
            $set: { slotTyp: 'TAG' }
        };

        // Schritt 1.4: Führe updateMany auf dem TEMPORÄREN Modell aus.
        const result = await TempSlotModel.updateMany(filter, update);

        // Schritt 2: Finde alle Slots, die noch keine Eltern-Kind-Struktur haben
        const slotsToMigrate = await Slot.find({ 
            slotStrukturTyp: { $exists: false } 
        });

        
        if (slotsToMigrate.length === 0) {
            console.log('Keine alten Kind-Slots zur Migration gefunden. Daten sind bereits auf dem neuesten Stand.');
        }else{
            console.log(`Gefunden: ${slotsToMigrate.length} alte Kind-Slots zur Migration...`);
        }        

        // Schritt 3: Iteriere durch jeden zu migrierenden Slot
        for (const kindSlot of slotsToMigrate) {
            // Dieser Slot wird zu einem KIND-Slot.
            
            // 3a. Erstelle den neuen ELTERN-Slot
            const elternSlot = new Slot({
                slotStrukturTyp: 'ELTERN',
                elternSlotTyp: kindSlot.slotTyp, // Übernehme TAG oder NACHT
                Linienbezeichnung: kindSlot.Linienbezeichnung,
                Verkehrstag: kindSlot.Verkehrstag,
                Kalenderwoche: kindSlot.Kalenderwoche,
                gabelAlternativen: [kindSlot._id], // Verweise auf das Kind
                VerweisAufTopf: kindSlot.VerweisAufTopf, // Übernehme den Verweis auf den Topf
                Abschnitt: kindSlot.Abschnitt,
                // Hat keine streckenspezifischen Daten wie von, bis etc.
            });
            await elternSlot.save(); // Speichern, um eine _id zu erhalten

            // 3b. Aktualisiere den ursprünglichen Slot, um ihn zu einem KIND zu machen
            kindSlot.slotStrukturTyp = 'KIND';
            kindSlot.gabelElternSlot = elternSlot._id; // Verweis auf den neuen Eltern-Teil
            const alterTopfVerweisId = kindSlot.VerweisAufTopf; // Merke dir die alte Topf-ID
            kindSlot.VerweisAufTopf = null; // Entferne den Verweis vom Kind
            await kindSlot.save();

            // 3c. Aktualisiere den Kapazitätstopf, falls vorhanden
            if (alterTopfVerweisId) {
                // Ersetze die ID des KIND-Slots durch die ID des neuen ELTERN-Slots
                await Kapazitaetstopf.updateOne(
                    { _id: alterTopfVerweisId },
                    { 
                        $pull: { ListeDerSlots: kindSlot._id }, // Entferne alte Kind-ID
                    }
                );
                await Kapazitaetstopf.updateOne(
                    { _id: alterTopfVerweisId },
                    {
                        $addToSet: { ListeDerSlots: elternSlot._id } // Füge neue Eltern-ID hinzu
                    }
                );
                // maxKapazitaet bleibt gleich, da ein Slot durch einen anderen ersetzt wird.
            }
            migratedCount++;
        }

        // Schritt 5: Finde alle Eltern-Slots, die noch keinen Abschnitt haben
        const slotsAbschnitt = await Slot.find({ 
            Abschnitt: { $exists: false } ,
            slotStrukturTyp: 'ELTERN',
        });

        console.log(`Gefunden: ${slotsAbschnitt.length} Eltern-Slots ohne Abschnitt...`);

        // Schritt 3: Iteriere durch jeden zu migrierenden Slot
        for (const elternSlot of slotsAbschnitt) {
            const kind = await Slot.findById(elternSlot.gabelAlternativen[0]);
            elternSlot.Abschnitt = kind.Abschnitt;
            await elternSlot.save();
            migratedCount++;
        }

        res.status(200).json({
            message: 'Migration zur Eltern-Kind-Struktur erfolgreich abgeschlossen.',
            summary: {
                migrierteDokumente: migratedCount,
                gefundeneDokumente: (slotsToMigrate.length + slotsAbschnitt.length)
            }
        });        

    } catch (error) {
        console.error('Fehler bei der Slot-Migration zur Eltern-Kind-Struktur:', error);
        res.status(500).json({ message: 'Serverfehler bei der Migration.' });
    }
};