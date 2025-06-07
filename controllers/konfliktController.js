// slot-buchungs-app/controllers/konfliktController.js
const mongoose = require('mongoose'); // Für ObjectId.isValid
const Kapazitaetstopf = require('../models/Kapazitaetstopf');
const KonfliktDokumentation = require('../models/KonfliktDokumentation');
const Anfrage = require('../models/Anfrage'); // für Populate
const Slot = require('../models/Slot'); // Benötigt, um Slot.VerweisAufTopf zu prüfen


// Diese Funktion vergleicht, ob alle IDs der Anfragen identisch sind.
function sindObjectIdArraysGleich(arr1, arr2) {
    if (!arr1 && !arr2) return true; // Beide null oder undefined sind gleich
    if (!arr1 || !arr2) return false; // Eines ist null/undefined, das andere nicht
    if (arr1.length !== arr2.length) return false;

    // Konvertiere zu Sets von Strings für den Vergleich
    const set1 = new Set(arr1.map(id => id.toString()));
    const set2 = new Set(arr2.map(id => id.toString()));

    if (set1.size !== set2.size) return false; // Sollte durch Längenprüfung schon abgedeckt sein, aber sicher ist sicher

    for (const idStr of set1) {
        if (!set2.has(idStr)) {
            return false;
        }
    }
    return true;
}

// HILFSFUNKTION 
/**
 * Aktualisiert den statusEinzelzuweisung für alle Slots einer Anfrage, die zu einem bestimmten Topf gehören,
 * und ruft dann die Methode zur Neuberechnung des Gesamtstatus der Anfrage auf.
 * @param {string|ObjectId} anfrageId - Die ID der zu aktualisierenden Anfrage.
 * @param {string} neuerEinzelStatus - Der neue Status für die relevanten Slot-Zuweisungen.
 * @param {ObjectId} ausloesenderTopfObjectId - Die ObjectId des Kapazitätstopfes, für den diese Entscheidung gilt.
 * @returns {Promise<Anfrage|null>} Das aktualisierte Anfrage-Objekt oder null bei Fehler.
 */
async function updateAnfrageSlotsStatusFuerTopf(anfrageId, neuerEinzelStatus, ausloesenderTopfObjectId) {
    const anfrageDoc = await Anfrage.findById(anfrageId).populate({
        path: 'ZugewieseneSlots.slot', // Populate das Slot-Objekt innerhalb des Arrays
        select: 'VerweisAufTopf SlotID_Sprechend' // Nur die benötigten Felder des Slots laden
    });

    if (!anfrageDoc) {
        console.warn(`Anfrage ${anfrageId} nicht gefunden beim Versuch, Einzelstatus zu aktualisieren.`);
        return null;
    }

    let anfrageModifiziert = false;
    if (anfrageDoc.ZugewieseneSlots && anfrageDoc.ZugewieseneSlots.length > 0) {
        for (const zuweisung of anfrageDoc.ZugewieseneSlots) {
            if (zuweisung.slot && zuweisung.slot.VerweisAufTopf && zuweisung.slot.VerweisAufTopf.equals(ausloesenderTopfObjectId)) {
                if (zuweisung.statusEinzelzuweisung !== neuerEinzelStatus) {
                    zuweisung.statusEinzelzuweisung = neuerEinzelStatus;
                    anfrageModifiziert = true;
                }
            }
        }
    }

    if (anfrageModifiziert) {
        anfrageDoc.markModified('ZugewieseneSlots');
        //console.log(`Gesamtstatus für Anfrage ${anfrageDoc.AnfrageID_Sprechend || anfrageDoc._id} vorher ${anfrageDoc.Status}`);
        await anfrageDoc.updateGesamtStatus(); // Methode aus Anfrage-Modell aufrufen
        await anfrageDoc.save();
        //console.log(`Gesamtstatus für Anfrage ${anfrageDoc.AnfrageID_Sprechend || anfrageDoc._id} nachher ${anfrageDoc.Status}`);
        console.log(`Einzelstatus und Gesamtstatus für Anfrage ${anfrageDoc.AnfrageID_Sprechend || anfrageDoc._id} aktualisiert (neuer Einzelstatus für Topf ${ausloesenderTopfObjectId}: ${neuerEinzelStatus}).`);
    }
    return anfrageDoc;
}

// @desc    Identifiziert Überbuchungen in Kapazitätstöpfen und legt Konfliktdokumente an
// @route   POST /api/konflikte/identifiziere-topf-konflikte
exports.identifiziereTopfKonflikte = async (req, res) => {
    try {
        const alleToepfe = await Kapazitaetstopf.find({})
            .populate('ListeDerAnfragen', '_id AnfrageID_Sprechend Status Entgelt') // Entgelt für spätere Reihung
            .populate('ListeDerSlots', '_id SlotID_Sprechend');

        let neuErstellteKonfliktDokus = [];
        let aktualisierteUndGeoeffneteKonflikte = [];
        let unveraenderteBestehendeKonflikte = [];
        let toepfeOhneKonflikt = [];

        for (const topf of alleToepfe) {
            if (topf.ListeDerAnfragen.length > topf.maxKapazitaet) {
                console.log(`Konflikt in Topf ${topf.TopfID || topf._id}: ${topf.ListeDerAnfragen.length} Anfragen > maxKap ${topf.maxKapazitaet}`);

                let konfliktDoku = await KonfliktDokumentation.findOne({
                    ausloesenderKapazitaetstopf: topf._id
                }).sort({ updatedAt: -1 });

                const aktuelleAnfragenAmTopfIds = topf.ListeDerAnfragen.map(a => a._id);

                if (konfliktDoku) {
                    const gespeicherteAnfragenImKonfliktIds = konfliktDoku.beteiligteAnfragen;
                    if (!sindObjectIdArraysGleich(aktuelleAnfragenAmTopfIds, gespeicherteAnfragenImKonfliktIds)) {
                        console.log(`Konfliktdokument ${konfliktDoku._id} für Topf ${topf.TopfID}: Beteiligte Anfragen haben sich geändert. Wird zurückgesetzt.`);
                        konfliktDoku.beteiligteAnfragen = aktuelleAnfragenAmTopfIds;
                        konfliktDoku.status = 'offen';
                        konfliktDoku.zugewieseneAnfragen = [];
                        konfliktDoku.abgelehnteAnfragenEntgeltvergleich = [];
                        konfliktDoku.abgelehnteAnfragenHoechstpreis = [];
                        konfliktDoku.ReihungEntgelt = [];
                        konfliktDoku.ListeGeboteHoechstpreis = [];
                        konfliktDoku.ListeAnfragenMitVerzicht = [];
                        konfliktDoku.ListeAnfragenVerschubKoordination = [];
                        konfliktDoku.abschlussdatum = undefined;
                        konfliktDoku.notizen = `${konfliktDoku.notizen || ''}\nKonflikt am ${new Date().toISOString()} neu bewertet/eröffnet aufgrund geänderter Anfragesituation. Ursprünglicher Status: ${konfliktDoku.status}.`;
                        
                        await konfliktDoku.save();
                        aktualisierteUndGeoeffneteKonflikte.push(konfliktDoku);
                    } else {
                        console.log(`Konfliktdokument ${konfliktDoku._id} für Topf ${topf.TopfID}: Beteiligte Anfragen sind identisch. Status (${konfliktDoku.status}) bleibt erhalten.`);
                        unveraenderteBestehendeKonflikte.push(konfliktDoku);
                    }
                } else {
                    const neuesKonfliktDoku = new KonfliktDokumentation({
                        beteiligteAnfragen: aktuelleAnfragenAmTopfIds,
                        ausloesenderKapazitaetstopf: topf._id,
                        status: 'offen',
                        notizen: `Automatisch erstellter Konflikt für Kapazitätstopf ${topf.TopfID || topf._id} am ${new Date().toISOString()}. ${topf.ListeDerAnfragen.length} Anfragen bei max. Kapazität von ${topf.maxKapazitaet}.`
                    });
                    await neuesKonfliktDoku.save();
                    neuErstellteKonfliktDokus.push(neuesKonfliktDoku);
                    console.log(`Neues Konfliktdokument ${neuesKonfliktDoku._id} für Topf ${topf.TopfID} erstellt.`);
                }
            } else {
                toepfeOhneKonflikt.push(topf.TopfID || topf._id);
            }
        }

        res.status(200).json({
            message: 'Konfliktdetektion für Kapazitätstöpfe abgeschlossen.',
            neuErstellteKonflikte: neuErstellteKonfliktDokus.map(d => ({ id: d._id, topf: d.ausloesenderKapazitaetstopf, status: d.status })),
            aktualisierteUndGeoeffneteKonflikte: aktualisierteUndGeoeffneteKonflikte.map(d => ({ id: d._id, topf: d.ausloesenderKapazitaetstopf, status: d.status })),
            unveraenderteBestehendeKonflikte: unveraenderteBestehendeKonflikte.map(d => ({ id: d._id, topf: d.ausloesenderKapazitaetstopf, status: d.status })),
            toepfeOhneKonflikt: toepfeOhneKonflikt
        });

    } catch (error) {
        console.error('Fehler bei der Identifizierung von Topf-Konflikten:', error);
        res.status(500).json({ message: 'Serverfehler bei der Konfliktdetektion.' });
    }
};

// @desc    Ruft alle Konfliktdokumentationen ab
// @route   GET /api/konflikte
exports.getAllKonflikte = async (req, res) => {
    try {
        const queryParams = req.query;
        let filter = {};
        let sortOptions = { createdAt: -1 }; // Neueste zuerst als Standard

        if (queryParams.status) {
            filter.status = queryParams.status;
        }
        if (queryParams.ausloesenderKapazitaetstopf) {
            if (mongoose.Types.ObjectId.isValid(queryParams.ausloesenderKapazitaetstopf)) {
                filter.ausloesenderKapazitaetstopf = queryParams.ausloesenderKapazitaetstopf;
            } else {
                // Versuche, nach TopfID (sprechend) zu filtern, erfordert zusätzlichen Schritt
                const topf = await Kapazitaetstopf.findOne({ TopfID: queryParams.ausloesenderKapazitaetstopf }).select('_id');
                if (topf) {
                    filter.ausloesenderKapazitaetstopf = topf._id;
                } else {
                    // Wenn TopfID nicht gefunden, leeres Ergebnis für diesen Filter zurückgeben
                    return res.status(200).json({ message: 'Keine Konflikte für die angegebene TopfID gefunden (TopfID nicht existent).', data: [], totalCount: 0 });
                }
            }
        }

        if (queryParams.sortBy) {
            const parts = queryParams.sortBy.split(':');
            sortOptions = {};
            sortOptions[parts[0]] = parts[1] === 'desc' ? -1 : 1;
        }
        
        const page = parseInt(queryParams.page, 10) || 1;
        const limit = parseInt(queryParams.limit, 10) || 10;
        const skip = (page - 1) * limit;

        const konflikte = await KonfliktDokumentation.find(filter)
            .populate('ausloesenderKapazitaetstopf', 'TopfID Abschnitt Verkehrsart Kalenderwoche Verkehrstag Zeitfenster')
            .populate('beteiligteAnfragen', 'AnfrageID_Sprechend Zugnummer EVU Status')
            // Später auch andere Felder populieren, wenn sie gefüllt sind:
            // .populate('zugewieseneAnfragen', 'AnfrageID_Sprechend Zugnummer')
            .sort(sortOptions)
            .skip(skip)
            .limit(limit);

        const totalKonflikte = await KonfliktDokumentation.countDocuments(filter);

        res.status(200).json({
            message: 'Konfliktdokumentationen erfolgreich abgerufen.',
            data: konflikte,
            currentPage: page,
            totalPages: Math.ceil(totalKonflikte / limit),
            totalCount: totalKonflikte
        });

    } catch (error) {
        console.error('Fehler beim Abrufen aller Konfliktdokumentationen:', error);
        res.status(500).json({ message: 'Serverfehler beim Abrufen der Konfliktdokumentationen.' });
    }
};

// @desc    Ruft eine spezifische Konfliktdokumentation ab
// @route   GET /api/konflikte/:konfliktId
exports.getKonfliktById = async (req, res) => {
    try {
        const konfliktId = req.params.konfliktId;

        if (!mongoose.Types.ObjectId.isValid(konfliktId)) {
            return res.status(400).json({ message: 'Ungültiges Format für Konflikt-ID.' });
        }

        const konflikt = await KonfliktDokumentation.findById(konfliktId)
            .populate('ausloesenderKapazitaetstopf', 'TopfID Abschnitt Verkehrsart Kalenderwoche Verkehrstag Zeitfenster maxKapazitaet ListeDerSlots') // Mehr Details zum Topf
            .populate({
                path: 'beteiligteAnfragen',
                select: 'AnfrageID_Sprechend Zugnummer EVU Status Verkehrsart Verkehrstag Zeitraum',
                populate: { path: 'ZugewieseneSlots', select: 'SlotID_Sprechend von bis' } // Beispiel für verschachteltes Populate
            })
            .populate('zugewieseneAnfragen', 'AnfrageID_Sprechend Zugnummer EVU')
            .populate('abgelehnteAnfragenEntgeltvergleich', 'AnfrageID_Sprechend Zugnummer EVU')
            .populate('abgelehnteAnfragenHoechstpreis', 'AnfrageID_Sprechend Zugnummer EVU')
            .populate('ListeAnfragenMitVerzicht', 'AnfrageID_Sprechend Zugnummer EVU')
            .populate({
                 path: 'ListeAnfragenVerschubKoordination.anfrage', // Pfad zum ObjectId im Array von Objekten
                 select: 'AnfrageID_Sprechend Zugnummer EVU'
            });


        if (!konflikt) {
            return res.status(404).json({ message: 'Konfliktdokumentation nicht gefunden.' });
        }

        res.status(200).json({
            message: 'Konfliktdokumentation erfolgreich abgerufen.',
            data: konflikt
        });

    } catch (error) {
        console.error('Fehler beim Abrufen der Konfliktdokumentation anhand der ID:', error);
        if (error.name === 'CastError') { // Sollte durch isValid oben abgefangen werden
            return res.status(400).json({ message: 'Ungültiges ID-Format.' });
        }
        res.status(500).json({ message: 'Serverfehler beim Abrufen der Konfliktdokumentation.' });
    }
};

// Phase 1 Controller-Funktion
// @desc    Verarbeitet Verzichte/Verschiebungen und löst Konflikt ggf. automatisch
// @route   PUT /api/konflikte/:konfliktId/verzicht-verschub
exports.verarbeiteVerzichtVerschub = async (req, res) => {
    const { konfliktId } = req.params;
    const { ListeAnfragenMitVerzicht, ListeAnfragenVerschubKoordination, notizen, notizenUpdateMode } = req.body;

    if (!mongoose.Types.ObjectId.isValid(konfliktId)) {
        return res.status(400).json({ message: 'Ungültiges Format für Konflikt-ID.' });
    }

    try {
        const konflikt = await KonfliktDokumentation.findById(konfliktId)
            .populate('beteiligteAnfragen', '_id Status Entgelt') // Lade _id und Status für Filterung und Entgelt für Info
            .populate('ausloesenderKapazitaetstopf', 'maxKapazitaet TopfID _id');

        if (!konflikt) {
            return res.status(404).json({ message: 'Konfliktdokumentation nicht gefunden.' });
        }
        if (!konflikt.ausloesenderKapazitaetstopf) {
            return res.status(500).json({ message: 'Konfliktdokumentation hat keinen verknüpften Kapazitätstopf.' });
        }
        // Erlaube Bearbeitung nur, wenn Status z.B. 'offen' oder 'in_bearbeitung' (oder spezifischer vorheriger Schritt)
        if (!['offen', 'in_bearbeitung'].includes(konflikt.status)) {
            return res.status(400).json({ message: `Konflikt ist im Status '${konflikt.status}' und kann nicht über diesen Endpunkt bearbeitet werden.` });
        }

        const ausloesenderTopfId = konflikt.ausloesenderKapazitaetstopf._id;

        // Verzicht verarbeiten
        if (ListeAnfragenMitVerzicht && Array.isArray(ListeAnfragenMitVerzicht)) {
            konflikt.ListeAnfragenMitVerzicht = ListeAnfragenMitVerzicht.map(item => 
                typeof item === 'string' ? item : item.anfrage || item._id || item
            );
            konflikt.markModified('ListeAnfragenMitVerzicht');
            for (const anfrageId of konflikt.ListeAnfragenMitVerzicht) {
                await updateAnfrageSlotsStatusFuerTopf(anfrageId, 'abgelehnt_topf_verzichtet', ausloesenderTopfId);
            }
        }

        // Verschub/Koordination verarbeiten
        if (ListeAnfragenVerschubKoordination && Array.isArray(ListeAnfragenVerschubKoordination)) {
            konflikt.ListeAnfragenVerschubKoordination = ListeAnfragenVerschubKoordination; // Erwartet [{anfrage, details}]
            konflikt.markModified('ListeAnfragenVerschubKoordination');
            for (const item of konflikt.ListeAnfragenVerschubKoordination) {
                // Annahme: 'abgelehnt_topf_verschoben' für DIESEN Konfliktpunkt, da die Anfrage eine Alternative hat
                await updateAnfrageSlotsStatusFuerTopf(item.anfrage, 'abgelehnt_topf_verschoben', ausloesenderTopfId);
            }
        }

        // Aktive Anfragen für diesen Konflikt ermitteln (die nicht verzichtet oder verschoben wurden)
        const anfragenIdsMitVerzicht = new Set((konflikt.ListeAnfragenMitVerzicht || []).map(id => id.toString()));
        const anfragenIdsMitVerschub = new Set((konflikt.ListeAnfragenVerschubKoordination || []).map(item => item.anfrage.toString()));
        
        const aktiveAnfragenImKonflikt = konflikt.beteiligteAnfragen.filter(anfrageDoc => 
            !anfragenIdsMitVerzicht.has(anfrageDoc._id.toString()) && 
            !anfragenIdsMitVerschub.has(anfrageDoc._id.toString())
        );

        // Prüfen, ob Kapazität nun ausreicht
        const maxKap = konflikt.ausloesenderKapazitaetstopf.maxKapazitaet;
        if (aktiveAnfragenImKonflikt.length <= maxKap) {
            konflikt.zugewieseneAnfragen = aktiveAnfragenImKonflikt.map(a => a._id);
            // Alte Resolution-Felder für Entgelt/Höchstpreis zurücksetzen, falls dies eine neue Lösung ist
            konflikt.abgelehnteAnfragenEntgeltvergleich = [];
            konflikt.abgelehnteAnfragenHoechstpreis = [];
            konflikt.ReihungEntgelt = [];
            konflikt.ListeGeboteHoechstpreis = [];
            
            konflikt.status = 'geloest';
            konflikt.abschlussdatum = new Date();
            konflikt.notizen = (konflikt.notizen ? konflikt.notizen + "\n---\n" : "") + `Konflikt am ${new Date().toLocaleString()} nach Verzicht/Verschub automatisch gelöst.`;

            for (const anfrageDoc of aktiveAnfragenImKonflikt) {
                await updateAnfrageSlotsStatusFuerTopf(anfrageDoc._id, 'bestaetigt_topf', ausloesenderTopfId);
                anfrageDoc.markModified
            }
            console.log(`Konflikt ${konflikt._id} automatisch nach Verzicht/Verschub gelöst.`);
        } else {
            // Konflikt besteht weiterhin, bereit für Entgeltvergleich
            konflikt.status = 'in_bearbeitung_entgelt';
            konflikt.zugewieseneAnfragen = []; // Noch keine finale Zuweisung in diesem Schritt
            konflikt.notizen = (konflikt.notizen ? konflikt.notizen + "\n---\n" : "") + `Konflikt am ${new Date().toLocaleString()} nach Verzicht/Verschub nicht gelöst. Nächster Schritt: Entgeltvergleich.`;
            console.log(`Konflikt ${konflikt._id} nach Verzicht/Verschub nicht gelöst, Status: ${konflikt.status}.`);
        }
        
        // Allgemeine Notizen aus dem Request Body verarbeiten
        if (notizen !== undefined) {
            const notizPrefix = `Ergänzung vom ${new Date().toLocaleString()}:\n`;
            if (notizenUpdateMode === 'append' && konflikt.notizen) {
                konflikt.notizen += "\n---\n" + notizPrefix + notizen;
            } else {
                konflikt.notizen = (konflikt.notizen && notizenUpdateMode === 'append' ? konflikt.notizen + "\n---\n" : "") + notizPrefix + notizen;
            }
            konflikt.markModified('notizen');
        }

        const aktualisierterKonflikt = await konflikt.save();

        res.status(200).json({
            message: `Verzicht/Verschub für Konflikt ${konflikt.TopfID || konflikt._id} verarbeitet. Neuer Status: ${aktualisierterKonflikt.status}`,
            data: aktualisierterKonflikt
        });

    } catch (error) {
        console.error(`Fehler bei PUT /api/konflikte/${konfliktId}/verzicht-verschub:`, error);
        if (error.name === 'CastError') {
            return res.status(400).json({ message: 'Ungültige Daten im Request Body (z.B. ObjectId Format).', errorDetails: error.message });
        }
        res.status(500).json({ message: 'Serverfehler bei der Verarbeitung von Verzicht/Verschub.' });
    }
};

// Phase 2 Controller-Funktion
// @desc    Führt den Entgeltvergleich für einen Konflikt durch
// @route   PUT /api/konflikte/:konfliktId/entgeltvergleich
exports.fuehreEntgeltvergleichDurch = async (req, res) => {
    console.log("Starte Entgeltvergleich")
    console.log(req.params);
    console.log(req.body);
    const { konfliktId } = req.params;
    const { notizen, notizenUpdateMode } = req.body || {}; // Nur Notizen werden optional erwartet

    if (!mongoose.Types.ObjectId.isValid(konfliktId)) {
        return res.status(400).json({ message: 'Ungültiges Format für Konflikt-ID.' });
    }

    try {
        const konflikt = await KonfliktDokumentation.findById(konfliktId)
            .populate('beteiligteAnfragen', '_id Status Entgelt AnfrageID_Sprechend EVU')
            .populate('ausloesenderKapazitaetstopf', 'maxKapazitaet TopfID _id');

        if (!konflikt) {
            return res.status(404).json({ message: 'Konfliktdokumentation nicht gefunden.' });
        }
        if (!konflikt.ausloesenderKapazitaetstopf) {
            return res.status(500).json({ message: 'Konfliktdokumentation hat keinen verknüpften Kapazitätstopf.' });
        }

        // Erlaube Bearbeitung nur, wenn Status passend ist (z.B. nach Verzicht/Verschub oder initial offen)
        if (!['offen', 'in_bearbeitung_entgelt', 'in_bearbeitung'].includes(konflikt.status)) {
            return res.status(400).json({ message: `Konflikt ist im Status '${konflikt.status}' und der Entgeltvergleich kann nicht (erneut) durchgeführt werden, ohne ihn ggf. zurückzusetzen.` });
        }

        const ausloesenderTopfId = konflikt.ausloesenderKapazitaetstopf._id;
        const maxKap = konflikt.ausloesenderKapazitaetstopf.maxKapazitaet;

        // Aktive Anfragen für diesen Konflikt ermitteln (die nicht verzichtet oder verschoben wurden)
        // Dies basiert auf den bereits im Konfliktdokument gespeicherten Listen
        const anfragenIdsMitVerzicht = new Set((konflikt.ListeAnfragenMitVerzicht || []).map(id => id.toString()));
        const anfragenIdsMitVerschub = new Set((konflikt.ListeAnfragenVerschubKoordination || []).map(item => item.anfrage.toString()));
        
        const aktiveAnfragenFuerEntgeltvergleich = konflikt.beteiligteAnfragen.filter(anfrageDoc => 
            !anfragenIdsMitVerzicht.has(anfrageDoc._id.toString()) && 
            !anfragenIdsMitVerschub.has(anfrageDoc._id.toString())
        );
        
        console.log(`Konflikt ${konflikt._id}: Entgeltvergleich wird durchgeführt für ${aktiveAnfragenFuerEntgeltvergleich.length} Anfragen.`);

        // ReihungEntgelt automatisch erstellen und sortieren
        konflikt.ReihungEntgelt = aktiveAnfragenFuerEntgeltvergleich
            .map(anfr => ({
                anfrage: anfr._id,
                entgelt: anfr.Entgelt || 0, // Nutze das in der Anfrage gespeicherte Entgelt
            }))
            .sort((a, b) => (b.entgelt || 0) - (a.entgelt || 0)); // Absteigend nach Entgelt

        konflikt.ReihungEntgelt.forEach((item, index) => item.rang = index + 1);
        konflikt.markModified('ReihungEntgelt');
        console.log(`Konflikt ${konflikt._id}: ReihungEntgelt automatisch erstellt mit ${konflikt.ReihungEntgelt.length} Einträgen.`);

        // Felder für Zuweisung/Ablehnung zurücksetzen, bevor sie neu befüllt werden
        konflikt.zugewieseneAnfragen = [];
        konflikt.abgelehnteAnfragenEntgeltvergleich = [];
        konflikt.abgelehnteAnfragenHoechstpreis = []; // Sicherstellen, dass dies auch leer ist für diese Phase
            
        let aktuelleKapazitaetBelegt = 0;
        let anfragenFuerHoechstpreis = []; // Sammelt Anfrage-IDs für den Fall eines Gleichstands
        let letztesAkzeptiertesEntgelt = null;
        let entgeltGleichstand = 0;

        for (const gereihteAnfrageItem of konflikt.ReihungEntgelt) {
            const anfrageId = gereihteAnfrageItem.anfrage; // Ist bereits ObjectId
            const anfrageEntgelt = gereihteAnfrageItem.entgelt;

            if (aktuelleKapazitaetBelegt < maxKap) {
                // Dieser Block prüft, ob die aktuelle Anfrage noch in die Kapazität passt.
                // Und ob es einen Gleichstand mit der nächsten gibt, falls dieser die Kapazität sprengen würde.
                let istGleichstandAnGrenze = false;
                const anzahlNochZuVergebenderPlaetze = maxKap - aktuelleKapazitaetBelegt;
                const anzahlKandidatenMitDiesemEntgelt = konflikt.ReihungEntgelt.filter(r => r.entgelt === anfrageEntgelt && !aktiveAnfragenFuerEntgeltvergleich.find(a => a._id.equals(r.anfrage) && (anfragenIdsMitVerzicht.has(a._id.toString()) || anfragenIdsMitVerschub.has(a._id.toString()))) ).length;


                if (anzahlKandidatenMitDiesemEntgelt > anzahlNochZuVergebenderPlaetze && anfrageEntgelt === gereihteAnfrageItem.entgelt) {
                     // Mehr Kandidaten mit diesem Entgelt als freie Plätze -> Alle mit diesem Entgelt gehen in Höchstpreis
                    istGleichstandAnGrenze = true;
                    entgeltGleichstand = anfrageEntgelt;
                }

                if (istGleichstandAnGrenze) {
                    konflikt.ReihungEntgelt.filter(r => r.entgelt === anfrageEntgelt).forEach(rAnfrage => {
                         if (!anfragenFuerHoechstpreis.some(id => id.equals(rAnfrage.anfrage))) {
                            anfragenFuerHoechstpreis.push(rAnfrage.anfrage);
                        }
                    });
                    // Da alle mit diesem Entgelt in HP gehen, werden hier keine weiteren Plätze belegt
                    // und wir können die Schleife für dieses Entgelt-Niveau beenden bzw. die nächsten nur noch ablehnen.
                    // Also: wir brechen hier nicht ab, sondern lassen die untere Logik die Ablehnung machen

                } else { //max Kapazität noch nicht erreicht
                    if(anfrageEntgelt >= entgeltGleichstand) { //freier Platz wird belegt
                        konflikt.zugewieseneAnfragen.push(anfrageId);
                        await updateAnfrageSlotsStatusFuerTopf(anfrageId, 'bestaetigt_topf_entgelt', ausloesenderTopfId);
                        aktuelleKapazitaetBelegt++;
                        letztesAkzeptiertesEntgelt = anfrageEntgelt; // Merke dir das Entgelt des letzten, der reingepasst hat
                    }else { // Sonderfall: letzte Plätze sind nur deswegen noch frei weil vorher Anfragen 
                            // ins Höchstpreisverfahren gegangen sind und um diese freien Plätze konkurrieren
                            // Die Anfragen mit geringerem Entgelt werden dann abgelehnt
                        konflikt.abgelehnteAnfragenEntgeltvergleich.push(anfrageId);
                        await updateAnfrageSlotsStatusFuerTopf(anfrageId, 'abgelehnt_topf_entgelt', ausloesenderTopfId);
                    }
                    
                }
            } else { // Kapazität ist voll
                // Ist diese Anfrage Teil eines Gleichstands mit dem letzten akzeptierten?
                if (anfrageEntgelt === letztesAkzeptiertesEntgelt && !anfragenFuerHoechstpreis.some(id => id.equals(anfrageId))) {
                    // Ja, diese Anfrage gehört auch zu den Gleichstandskandidaten
                    anfragenFuerHoechstpreis.push(anfrageId);
                } else if (!anfragenFuerHoechstpreis.some(id => id.equals(anfrageId))) { 
                    // Nein, eindeutig zu niedriges Entgelt oder nicht Teil des Gleichstands -> Ablehnung
                    konflikt.abgelehnteAnfragenEntgeltvergleich.push(anfrageId);
                    await updateAnfrageSlotsStatusFuerTopf(anfrageId, 'abgelehnt_topf_entgelt', ausloesenderTopfId);
                }
            }
        } // Ende der Schleife durch ReihungEntgelt

        // Entferne die Höchstpreis-Kandidaten aus den regulär Zugewiesenen, falls sie dort gelandet sind
        if (anfragenFuerHoechstpreis.length > 0) {
            konflikt.zugewieseneAnfragen = konflikt.zugewieseneAnfragen.filter(
                zugewiesenId => !anfragenFuerHoechstpreis.some(hpId => hpId.equals(zugewiesenId))
            );
        }

        // Setze finalen Status für diesen Schritt
        if (anfragenFuerHoechstpreis.length > 0) {
            konflikt.status = 'in_bearbeitung_hoechstpreis';
            for (const anfrageId of anfragenFuerHoechstpreis) {
                await updateAnfrageSlotsStatusFuerTopf(anfrageId, 'wartet_hoechstpreis_topf', ausloesenderTopfId);
            }
            konflikt.notizen = (konflikt.notizen ? konflikt.notizen + "\n---\n" : "") + `Entgeltvergleich am ${new Date().toLocaleString()} führte zu Gleichstand. Höchstpreisverfahren für ${anfragenFuerHoechstpreis.length} Anfragen eingeleitet.`;
        } else { // Kein Gleichstand, Konflikt durch Entgelt gelöst
            konflikt.status = 'geloest';
            konflikt.abschlussdatum = new Date();
            konflikt.notizen = (konflikt.notizen ? konflikt.notizen + "\n---\n" : "") + `Konflikt durch Entgeltvergleich am ${new Date().toLocaleString()} gelöst.`;
        }
        
        konflikt.markModified('zugewieseneAnfragen');
        konflikt.markModified('abgelehnteAnfragenEntgeltvergleich');

        // Allgemeine Notizen aus dem Request Body verarbeiten
        if (notizen !== undefined) {
            const notizPrefix = `Ergänzung vom ${new Date().toLocaleString()}:\n`;
            if (notizenUpdateMode === 'append' && konflikt.notizen) {
                konflikt.notizen += "\n---\n" + notizPrefix + notizen;
            } else {
                konflikt.notizen = (konflikt.notizen && notizenUpdateMode === 'append' ? konflikt.notizen + "\n---\n" : "") + notizPrefix + notizen;
            }
            konflikt.markModified('notizen');
        }

        const aktualisierterKonflikt = await konflikt.save();

        res.status(200).json({
            message: `Entgeltvergleich für Konflikt ${konflikt.TopfID || konflikt._id} durchgeführt. Neuer Status: ${aktualisierterKonflikt.status}`,
            data: aktualisierterKonflikt
        });

    } catch (error) {
        console.error(`Fehler bei PUT /api/konflikte/${konfliktId}/entgeltvergleich:`, error);
        // ... (Standardfehlerbehandlung)
        res.status(500).json({ message: 'Serverfehler beim Durchführen des Entgeltvergleichs.' });
    }
};


// Phase 3 Controller-Funktion
// @desc    Verarbeitet das Ergebnis des Höchstpreisverfahrens
// @route   PUT /api/konflikte/:konfliktId/hoechstpreis-ergebnis
exports.verarbeiteHoechstpreisErgebnis = async (req, res) => {
    const { konfliktId } = req.params;
    const { ListeGeboteHoechstpreis, notizen, notizenUpdateMode } = req.body;

    if (!mongoose.Types.ObjectId.isValid(konfliktId)) {
        return res.status(400).json({ message: 'Ungültiges Format für Konflikt-ID.' });
    }
    if (!ListeGeboteHoechstpreis || !Array.isArray(ListeGeboteHoechstpreis)) {
        return res.status(400).json({ message: 'ListeGeboteHoechstpreis (Array) muss im Request Body vorhanden sein.' });
    }

    try {
        const konflikt = await KonfliktDokumentation.findById(konfliktId)
            .populate('beteiligteAnfragen', '_id Status Entgelt AnfrageID_Sprechend ZugewieseneSlots') // Entgelt für Gebotsvalidierung
            .populate('ausloesenderKapazitaetstopf', 'maxKapazitaet TopfID _id');

        if (!konflikt) {
            return res.status(404).json({ message: 'Konfliktdokumentation nicht gefunden.' });
        }
        if (konflikt.status !== 'in_bearbeitung_hoechstpreis') {
            return res.status(400).json({ message: `Konflikt ist im Status '${konflikt.status}' und erwartet keine Höchstpreis-Ergebnisse.` });
        }
        if (!konflikt.ausloesenderKapazitaetstopf) {
            return res.status(500).json({ message: 'Konfliktdokumentation hat keinen verknüpften Kapazitätstopf.' });
        }

        konflikt.ListeGeboteHoechstpreis = ListeGeboteHoechstpreis; // Speichere alle eingegangenen Gebote
        konflikt.markModified('ListeGeboteHoechstpreis');

        const ausloesenderTopfId = konflikt.ausloesenderKapazitaetstopf._id;

        // 1. Anfragen identifizieren, die bieten sollten und Gebote validieren
        const anfragenKandidatenFuerHP = konflikt.beteiligteAnfragen.filter(aDoc => {
            //console.log(aDoc);
            // Gib nur Anfragen zurück, bei denen auf einen Höchstpreis gewartet wird
            for(const slot of aDoc.ZugewieseneSlots){
                //mindestens 1 Slot wartet auf Höchstpreisentscheidung
                if(slot.statusEinzelzuweisung === 'wartet_hoechstpreis_topf'){return true;}
            }
            return false; // keine der Slots der Anfrage wartet auf Höchtpreisentscheidung
        });

        let valideGebote = [];
        let anfragenOhneValidesGebot = [];

        for (const anfrageKandidat of anfragenKandidatenFuerHP) {
            //console.log(anfrageKandidat);
            const gebotEingang = ListeGeboteHoechstpreis.find(
                g => g.anfrage && g.anfrage.toString() === anfrageKandidat._id.toString()
            );

            if (gebotEingang && typeof gebotEingang.gebot === 'number') {
                if (gebotEingang.gebot > (anfrageKandidat.Entgelt || 0)) {
                    valideGebote.push({ anfrage: anfrageKandidat._id, gebot: gebotEingang.gebot });
                } else {
                    anfragenOhneValidesGebot.push(anfrageKandidat._id);
                    await updateAnfrageSlotsStatusFuerTopf(anfrageKandidat._id, 'abgelehnt_topf_hoechstpreis_ungueltig', ausloesenderTopfId);
                }
            } else {
                anfragenOhneValidesGebot.push(anfrageKandidat._id);
                await updateAnfrageSlotsStatusFuerTopf(anfrageKandidat._id, 'abgelehnt_topf_hoechstpreis_kein_gebot', ausloesenderTopfId);
            }
        }
        // Füge Anfragen ohne valides Gebot direkt zu den abgelehnten im Konfliktdokument hinzu
        anfragenOhneValidesGebot.forEach(id => konflikt.abgelehnteAnfragenHoechstpreis.addToSet(id));
        konflikt.markModified('abgelehnteAnfragenHoechstpreis');


        valideGebote.sort((a, b) => (b.gebot || 0) - (a.gebot || 0)); // Absteigend sortieren

        // 2. Verbleibende Kapazität ermitteln
        const maxKap = konflikt.ausloesenderKapazitaetstopf.maxKapazitaet;
        // Anzahl der bereits vor dieser HP-Runde sicher zugewiesenen Anfragen
        const bereitsSicherZugewieseneAnzahl = konflikt.zugewieseneAnfragen.length;
        let verbleibendeKapFuerHP = maxKap - bereitsSicherZugewieseneAnzahl;
        if (verbleibendeKapFuerHP < 0) verbleibendeKapFuerHP = 0;

        let neuZugewiesenInHP = [];
        let neuAbgelehntInHPWegenKap = [];
        let verbleibenImWartestatusHP = [];

        console.log(`HP-Runde: maxKap=${maxKap}, bereitsZugewiesen=${bereitsSicherZugewieseneAnzahl}, verbleibend=${verbleibendeKapFuerHP}`);
        console.log("Valide Gebote sortiert:", valideGebote);


        // 3. Valide Gebote verarbeiten
        for (let i = 0; i < valideGebote.length; i++) {
            const aktuellesGebot = valideGebote[i];
            const anfrageId = aktuellesGebot.anfrage;

            if (verbleibendeKapFuerHP > 0) {
                let istGleichstandAnGrenzeUndUnaufloesbar = false;
                // Prüfe, ob wir an der Grenze sind und es einen Gleichstand gibt, der nicht alle aufnehmen kann
                if (valideGebote.filter(g => g.gebot === aktuellesGebot.gebot).length > verbleibendeKapFuerHP && 
                    valideGebote.map(g => g.gebot).lastIndexOf(aktuellesGebot.gebot) >= i + verbleibendeKapFuerHP -1 && // aktuelles Gebot ist Teil der Grenzgruppe
                    valideGebote.map(g => g.gebot).indexOf(aktuellesGebot.gebot) < i + verbleibendeKapFuerHP ) {
                        istGleichstandAnGrenzeUndUnaufloesbar = true;
                }


                if (istGleichstandAnGrenzeUndUnaufloesbar) {
                    valideGebote.filter(g => g.gebot === aktuellesGebot.gebot).forEach(gEqual => {
                        if (!verbleibenImWartestatusHP.some(id => id.equals(gEqual.anfrage))) {
                            verbleibenImWartestatusHP.push(gEqual.anfrage);
                        }
                    });
                    verbleibendeKapFuerHP = 0; // Blockiert für diese Runde
                    // Setze i, um die Schleife nach dieser Gleichstandsgruppe fortzusetzen (für Ablehnungen)
                    const naechstesAnderesGebotIndex = valideGebote.findIndex(g => g.gebot < aktuellesGebot.gebot);
                    i = (naechstesAnderesGebotIndex === -1) ? valideGebote.length -1 : naechstesAnderesGebotIndex -1;
                } else { // Eindeutig gewonnen oder Gleichstand, der noch reinpasst
                    neuZugewiesenInHP.push(anfrageId);
                    await updateAnfrageSlotsStatusFuerTopf(anfrageId, 'bestaetigt_topf_hoechstpreis', ausloesenderTopfId);
                    verbleibendeKapFuerHP--;
                }
            } else { // Keine Kapazität mehr
                if (!verbleibenImWartestatusHP.some(idW => idW.equals(anfrageId))) {
                    neuAbgelehntInHPWegenKap.push(anfrageId);
                    await updateAnfrageSlotsStatusFuerTopf(anfrageId, 'abgelehnt_topf_hoechstpreis', ausloesenderTopfId);
                }
            }
        }

        // 4. Konfliktdokument aktualisieren
        neuZugewiesenInHP.forEach(id => konflikt.zugewieseneAnfragen.addToSet(id));
        neuAbgelehntInHPWegenKap.forEach(id => konflikt.abgelehnteAnfragenHoechstpreis.addToSet(id));
        
        konflikt.markModified('zugewieseneAnfragen');
        konflikt.markModified('abgelehnteAnfragenHoechstpreis');

        if (verbleibenImWartestatusHP.length > 0) {
            konflikt.status = 'in_bearbeitung_hoechstpreis'; // Bleibt für nächste Runde
            konflikt.notizen = `${konflikt.notizen || ''}\nHP-Runde (${new Date().toLocaleString()}): Erneuter Gleichstand für ${verbleibenImWartestatusHP.length} Anfragen. Nächste Bieterrunde erforderlich. Zugewiesen: ${neuZugewiesenInHP.length}, Abgelehnt wg. Kap: ${neuAbgelehntInHPWegenKap.length}, Ungült./Kein Gebot: ${anfragenOhneValidesGebot.length}.`;
            for (const anfrageId of verbleibenImWartestatusHP) { // Status der Wartenden explizit setzen/bestätigen
                await updateAnfrageSlotsStatusFuerTopf(anfrageId, 'wartet_hoechstpreis_topf', ausloesenderTopfId);
            }
        } else {
            konflikt.status = 'geloest';
            konflikt.abschlussdatum = new Date();
            konflikt.notizen = `${konflikt.notizen || ''}\nKonflikt durch Höchstpreisverfahren am ${new Date().toLocaleString()} gelöst. Zugewiesen: ${neuZugewiesenInHP.length}, Abgelehnt wg. Kap: ${neuAbgelehntInHPWegenKap.length}, Ungült./Kein Gebot: ${anfragenOhneValidesGebot.length}.`;
        }

        // Allgemeine Notizen aus dem Request Body verarbeiten
        if (notizen !== undefined) {
            const notizPrefix = `Ergänzung vom ${new Date().toLocaleString()}:\n`;
            if (notizenUpdateMode === 'append' && konflikt.notizen) {
                konflikt.notizen += "\n---\n" + notizPrefix + notizen;
            } else {
                konflikt.notizen = (konflikt.notizen && notizenUpdateMode === 'append' ? konflikt.notizen + "\n---\n" : "") + notizPrefix + notizen;
            }
            konflikt.markModified('notizen');
        }

        const aktualisierterKonflikt = await konflikt.save();

        res.status(200).json({
            message: `Höchstpreisverfahren für Konflikt ${konflikt.TopfID || konflikt._id} verarbeitet. Status: ${aktualisierterKonflikt.status}`,
            data: aktualisierterKonflikt
        });

    } catch (error) {
        console.error(`Fehler bei PUT /api/konflikte/${konfliktId}/hoechstpreis-ergebnis:`, error);
        res.status(500).json({ message: 'Serverfehler bei der Verarbeitung des Höchstpreis-Ergebnisses.' });
    }
};
