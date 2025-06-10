// slot-buchungs-app/controllers/anfrageController.js
const mongoose = require('mongoose');
const Anfrage = require('../models/Anfrage');
const Slot = require('../models/Slot');
const Kapazitaetstopf = require('../models/Kapazitaetstopf');
// Wichtig: date-fns installieren -> npm install date-fns
const {  parseISO, eachDayOfInterval, getDay } = require('date-fns');
const { UTCDate } = require('@date-fns/utc');
const { getGlobalRelativeKW } = require('../utils/date.helpers'); 
const KonfliktDokumentation = require('../models/KonfliktDokumentation'); // Benötigt für Konflikt-Prüfung




/**
 * Berechnet die Gesamtzahl der Betriebstage einer Anfrage basierend auf ihrem Zeitraum und Verkehrstag.
 * @param {object} anfrageZeitraum - { start: Date|string, ende: Date|string }
 * @param {string} anfrageVerkehrstagGruppe - 'Mo-Fr', 'Sa+So', oder 'täglich'
 * @returns {number} - Die Gesamtzahl der Betriebstage.
 */
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

async function calculateAnfrageEntgelt(anfrage, zugewieseneSlotsPopulated) {
    // anfrage: Das volle Anfrage-Objekt
    // zugewieseneSlotsPopulated: Ein Array der voll-populierten Slot-Objekte, die dieser Anfrage zugewiesen sind.
    
    if (!anfrage || !anfrage.Zeitraum || !anfrage.Verkehrstag || !anfrage.ListeGewuenschterSlotAbschnitte || anfrage.ListeGewuenschterSlotAbschnitte.length === 0) {
        return 0; // Grundvoraussetzungen nicht erfüllt
    }
    if (!zugewieseneSlotsPopulated || zugewieseneSlotsPopulated.length === 0) {
        console.warn(`Anfrage ${anfrage._id} (${anfrage.AnfrageID_Sprechend || ''}): Keine zugewiesenen Slots für Entgeltberechnung vorhanden.`);
        return 0; // Keine Slots zugewiesen, kein Entgelt
    }

    // Schritt 1: Berechne die Gesamtzahl der Tage, an denen die Anfrage als Ganzes verkehrt.
    // Dies nutzt deine vereinfachte Methode.
    const gesamtBetriebstageAnfrage = calculateTotalOperatingDaysForAnfrage(anfrage.Zeitraum, anfrage.Verkehrstag);
    if (gesamtBetriebstageAnfrage === 0) {
        console.warn(`Anfrage ${anfrage._id} (${anfrage.AnfrageID_Sprechend || ''}): Keine Betriebstage im Zeitraum für Entgeltberechnung. Zeitraum ${anfrage.Zeitraum}, Verkehrstag ${anfrage.Verkehrstag}`);
        
        return 0;
    }

    let summeGrundentgelteProDurchlauf = 0;

    // Schritt 2: Ermittle die Summe der Grundentgelte für EINEN kompletten Durchlauf der Anfrage.
    // Ein Durchlauf besteht aus allen Segmenten in anfrage.ListeGewuenschterSlotAbschnitte.
    for (const gewuenschterAbschnitt of anfrage.ListeGewuenschterSlotAbschnitte) {
        // Finde ein repräsentatives zugewiesenes Slot-Muster (aus einer beliebigen KW,
        // da wir annehmen, das Grundentgelt für diesen Slot-Typ ist über KWs hinweg gleich),
        // das den Eigenschaften des gewünschten Abschnitts entspricht.
        const passendesSlotDetail = zugewieseneSlotsPopulated.find(s =>
            s.von === gewuenschterAbschnitt.von &&
            s.bis === gewuenschterAbschnitt.bis &&
            s.Verkehrsart === anfrage.Verkehrsart && // Verkehrsart der Anfrage muss zum Slot passen
            s.Abfahrt.stunde === gewuenschterAbschnitt.Abfahrtszeit.stunde &&
            s.Abfahrt.minute === gewuenschterAbschnitt.Abfahrtszeit.minute &&
            s.Ankunft.stunde === gewuenschterAbschnitt.Ankunftszeit.stunde && // KORREKTUR: Ankunftszeit in den Match einbeziehen
            s.Ankunft.minute === gewuenschterAbschnitt.Ankunftszeit.minute
            // Der Abschnitt des Slots (Slot.Abschnitt) sollte hier auch matchen, wenn er für die Preisbildung relevant ist.
            // Wenn das Slot-Muster einzigartig durch von, bis, Zeiten, VA definiert ist, reicht das.
        );

        if (passendesSlotDetail && typeof passendesSlotDetail.Grundentgelt === 'number') {
            summeGrundentgelteProDurchlauf += passendesSlotDetail.Grundentgelt;
        } else {
            console.warn(`Für Abschnitt ${gewuenschterAbschnitt.von}->${gewuenschterAbschnitt.bis} (Abf ${gewuenschterAbschnitt.Abfahrtszeit.stunde}:${gewuenschterAbschnitt.Abfahrtszeit.minute}, Ank ${gewuenschterAbschnitt.Ankunftszeit.stunde}:${gewuenschterAbschnitt.Ankunftszeit.minute}) der Anfrage ${anfrage.AnfrageID_Sprechend || anfrage._id} konnte kein passendes zugewiesenes Slot-Detail mit Grundentgelt gefunden werden. Überprüfe zugewieseneSlotsPopulated und Matching-Kriterien.`);
            // Überlegung: Soll hier ein Fehler geworfen werden, wenn ein Teil des Weges kein Entgelt hat?
            // Das würde die Gesamtentgeltberechnung unvollständig machen.
            // Für den Moment wird dieser Teil mit 0€ gewertet.
        }
    }

    // Schritt 3: Gesamtentgelt berechnen
    return gesamtBetriebstageAnfrage * summeGrundentgelteProDurchlauf;
}

// Hilfsfunktion: Konvertiert {stunde, minute} zu Minuten seit Mitternacht
const timeToMinutes = (timeObj) => timeObj.stunde * 60 + timeObj.minute;

// HILFSFUNKTION für die Validierung von Anfragedaten
function validateAnfrageLogic(data) {
    const { ListeGewuenschterSlotAbschnitte, Zeitraum, Verkehrsart } = data;
    let validierungsfehler = [];

    // Basis-Validierung der übergebenen Daten (nur auf Existenz, Typen prüft Mongoose/Schema)
    if (!ListeGewuenschterSlotAbschnitte || ListeGewuenschterSlotAbschnitte.length === 0 ||
        !Zeitraum || !Zeitraum.start || !Zeitraum.ende || !Verkehrsart) {
        validierungsfehler.push('Interne Validierung: Notwendige Daten für die Detailvalidierung fehlen (SlotAbschnitte, Zeitraum, Verkehrsart).');
        return { errors: validierungsfehler, isValid: false }; // Früher Ausstieg, wenn Grunddaten fehlen
    }

    // Zeitraum-Validierung: >= 2 volle Jahre
    try {
        const startDate = new Date(Zeitraum.start);
        const endDate = new Date(Zeitraum.ende);
        const twoYearsAfterStartDate = new Date(startDate.getFullYear() + 2, startDate.getMonth(), startDate.getDate());
        if (endDate < twoYearsAfterStartDate) {
            validierungsfehler.push(`Zeitraum-Validierung: Der angefragte Zeitraum muss mindestens zwei volle Jahre umfassen. Ende: ${new Date(Zeitraum.ende).toISOString().split('T')[0]}, Erwartet mind.: ${twoYearsAfterStartDate.toISOString().split('T')[0]}`);
        }
    } catch (e) {
        validierungsfehler.push(`Zeitraum-Validierung: Ungültiges Datumsformat im Zeitraum.`);
    }

    // Pufferzeit basierend auf Verkehrsart
    let aktuellePufferzeitMinuten = 0;
    if (Verkehrsart === 'SPFV' || Verkehrsart === 'SGV') {
        aktuellePufferzeitMinuten = 2;
    } else if (Verkehrsart === 'SPNV') {
        aktuellePufferzeitMinuten = 0;
    } else {
        validierungsfehler.push(`Pufferzeit-Ermittlung: Unbekannte oder ungültige Verkehrsart '${Verkehrsart}'.`);
    }

    // Validierung der Slot-Abschnitte
    for (let i = 0; i < ListeGewuenschterSlotAbschnitte.length; i++) {
        const currentSegment = ListeGewuenschterSlotAbschnitte[i];
        const nextSegment = ListeGewuenschterSlotAbschnitte[i + 1];

        if (!currentSegment.von || !currentSegment.bis || !currentSegment.Abfahrtszeit || !currentSegment.Ankunftszeit ||
            typeof currentSegment.Abfahrtszeit.stunde !== 'number' || typeof currentSegment.Abfahrtszeit.minute !== 'number' ||
            typeof currentSegment.Ankunftszeit.stunde !== 'number' || typeof currentSegment.Ankunftszeit.minute !== 'number') {
            validierungsfehler.push(`Abschnitt ${i + 1}: Unvollständige oder fehlerhafte Daten (von, bis, Abfahrtszeit, Ankunftszeit).`);
            continue;
        }

        const abfahrtAktuellMinuten = timeToMinutes(currentSegment.Abfahrtszeit);
        const ankunftAktuellMinuten = timeToMinutes(currentSegment.Ankunftszeit);

        if (ankunftAktuellMinuten <= abfahrtAktuellMinuten) {
            validierungsfehler.push(`K2a (Abschnitt ${i + 1}: ${currentSegment.von} -> ${currentSegment.bis}): Ankunftszeit (${currentSegment.Ankunftszeit.stunde}:${String(currentSegment.Ankunftszeit.minute).padStart(2, '0')}) muss nach Abfahrtszeit (${currentSegment.Abfahrtszeit.stunde}:${String(currentSegment.Abfahrtszeit.minute).padStart(2, '0')}) liegen.`);
        }
        if (currentSegment.von === currentSegment.bis) {
            validierungsfehler.push(`K4a (Abschnitt ${i + 1}: ${currentSegment.von} -> ${currentSegment.bis}): Start- und Endpunkt dürfen nicht identisch sein.`);
        }

        if (nextSegment) {
            if (!nextSegment.von || !nextSegment.Abfahrtszeit || typeof nextSegment.Abfahrtszeit.stunde !== 'number' || typeof nextSegment.Abfahrtszeit.minute !== 'number' ) {
                 validierungsfehler.push(`Abschnitt ${i + 2}: Unvollständige Daten für Vergleich (von, Abfahrtszeit).`);
            } else {
                if (currentSegment.bis !== nextSegment.von) {
                    validierungsfehler.push(`K1 (Übergang ${i + 1} -> ${i + 2}): Räumliche Inkonsistenz. Endpunkt "${currentSegment.bis}" von Abschnitt ${i + 1} stimmt nicht mit Startpunkt "${nextSegment.von}" von Abschnitt ${i + 2} überein.`);
                }
                const abfahrtNaechsterMinuten = timeToMinutes(nextSegment.Abfahrtszeit);
                if (abfahrtNaechsterMinuten <= (ankunftAktuellMinuten + aktuellePufferzeitMinuten)) {
                    validierungsfehler.push(`K2b (Übergang ${i + 1} -> ${i + 2}): Zeitliche Inkonsistenz für Verkehrsart ${Verkehrsart}. Abfahrt Abschnitt ${i + 2} (${nextSegment.Abfahrtszeit.stunde}:${String(nextSegment.Abfahrtszeit.minute).padStart(2, '0')}) muss mindestens ${aktuellePufferzeitMinuten} Min. nach Ankunft Abschnitt ${i + 1} (${currentSegment.Ankunftszeit.stunde}:${String(currentSegment.Ankunftszeit.minute).padStart(2, '0')}) liegen.`);
                }
            }
        }
    }

    for (let i = 0; i < ListeGewuenschterSlotAbschnitte.length - 1; i++) {
        const seg1 = ListeGewuenschterSlotAbschnitte[i];
        const seg2 = ListeGewuenschterSlotAbschnitte[i+1];
         if (seg1.von && seg1.bis && seg2.von && seg2.bis && /*Stelle sicher, dass alle Felder existieren*/
            seg1.von === seg2.bis && seg1.bis === seg2.von) {
             validierungsfehler.push(`K4b (Abschnitte ${i+1}-${i+2}): Direkte Umkehrung der Fahrtrichtung (${seg1.von} -> ${seg1.bis} dann ${seg2.von} -> ${seg2.bis}) ist nicht erlaubt.`);
        }
    }
    return { errors: validierungsfehler, isValid: validierungsfehler.length === 0 };
}

// exports.createAnfrage wurde angepasst, um validateAnfrageLogic zu nutzen
exports.createAnfrage = async (req, res) => {
    try {
        const {
            Zugnummer, EVU, ListeGewuenschterSlotAbschnitte, Verkehrsart,
            Verkehrstag, Zeitraum, Email
        } = req.body;

        // Einfache Eingabevalidierung (Pflichtfelder)
        if (!Zugnummer || !EVU || !ListeGewuenschterSlotAbschnitte || ListeGewuenschterSlotAbschnitte.length === 0 ||
            !Verkehrsart || !Verkehrstag || !Zeitraum || !Email || !Zeitraum.start || !Zeitraum.ende) {
            // Hier speichern wir die Anfrage trotzdem mit Fehlern, wie besprochen
            const tempAnfrage = new Anfrage({ ...req.body, Status: 'ungueltig', Validierungsfehler: ['Basis-Validierung: Bitte alle erforderlichen Felder korrekt ausfüllen.'] });
            try {
                await tempAnfrage.save();
                 return res.status(201).json({ // 201, da erstellt, wenn auch fehlerhaft
                    message: 'Anfrage unvollständig erstellt und als ungültig markiert.',
                    data: tempAnfrage
                });
            } catch (saveError) {
                // Falls selbst das Speichern der Basisdaten scheitert (z.B. EVU/Zugnummer fehlen für ID-Hook)
                console.error('Fehler beim Speichern der unvollständigen Anfrage:', saveError);
                return res.status(400).json({ message: 'Grundlegende Daten fehlen oder sind fehlerhaft, Anfrage konnte nicht erstellt werden.', errors: [saveError.message] });
            }
        }

        // Detailvalidierung mit der Hilfsfunktion
        const validationResult = validateAnfrageLogic({ ListeGewuenschterSlotAbschnitte, Zeitraum, Verkehrsart });

        const neueAnfrage = new Anfrage({
            Zugnummer, EVU, ListeGewuenschterSlotAbschnitte, Verkehrsart,
            Verkehrstag, Zeitraum, Email,
            Status: validationResult.isValid ? 'validiert' : 'ungueltig',
            Validierungsfehler: validationResult.errors
        });

        await neueAnfrage.save();

        if (!validationResult.isValid) {
            return res.status(201).json({ // 201 Created, aber mit Validierungsfehlern
                message: 'Anfrage erstellt, aber sie enthält Validierungsfehler und ist ungültig.',
                data: neueAnfrage
            });
        } else {
            return res.status(201).json({
                message: 'Anfrage erfolgreich erstellt und validiert.',
                data: neueAnfrage
            });
        }

    } catch (error) {
        // ... (bestehende Fehlerbehandlung, ggf. anpassen für Mongoose ValidationErrors)
        console.error('Fehler beim Erstellen der Anfrage:', error);
        if (error.name === 'ValidationError') {
            const messages = Object.values(error.errors).map(val => val.message);
            // Versuche, trotzdem zu speichern, wenn möglich
            const errorAnfrage = new Anfrage({ ...req.body, Status: 'ungueltig', Validierungsfehler: messages });
            try {
                 // Nur speichern, wenn die absolut notwendigen Daten für das Schema da sind
                if (req.body.Zugnummer && req.body.EVU /* Weitere Checks für Kernfelder... */) {
                    await errorAnfrage.save();
                    return res.status(201).json({
                        message: 'Anfrage mit Schema-Validierungsfehlern erstellt und als ungültig markiert.',
                        errors: messages,
                        data: errorAnfrage
                    });
                } else {
                     return res.status(400).json({ message: 'Schema-Validierungsfehler und unzureichende Daten zum Speichern.', errors: messages });
                }
            } catch (saveError) {
                 return res.status(500).json({ message: 'Serverfehler beim Versuch, die fehlerhafte Anfrage zu speichern.' });
            }
        }
        res.status(500).json({ message: 'Unbekannter Serverfehler beim Erstellen der Anfrage.' });
    }
};

// @desc    Ruft alle Anfragen ab
// @route   GET /api/anfragen
exports.getAllAnfragen = async (req, res) => {
    try {
        const queryParams = req.query;
        let filter = {};
        let sortOptions = {createdAt: -1};

        // Filter-Logik
        if (queryParams.status) {
            filter.Status = queryParams.status;
        }
        if (queryParams.EVU) {
            // Verwendung einer Regex für eine Teilstring-Suche (case-insensitive)
            filter.EVU = { $regex: queryParams.EVU, $options: 'i' };
        }
        if (queryParams.Zugnummer) {
            filter.Zugnummer = { $regex: queryParams.Zugnummer, $options: 'i' };
        }
        if (queryParams.Verkehrsart) {
            filter.Verkehrsart = queryParams.Verkehrsart;
        }
        if (queryParams.Verkehrstag) {
            filter.Verkehrstag = queryParams.Verkehrstag;
        }
        // Man könnte auch nach Zeitraum filtern, das wäre aber komplexer (z.B. Anfragen, deren Zeitraum einen bestimmten Punkt schneidet)
        // Beispiel: Nach Anfragen filtern, die ab einem bestimmten Datum erstellt wurden
        if (queryParams.createdAfter) {
            filter.createdAt = { $gte: new Date(queryParams.createdAfter) };
        }

        // Sortier-Logik
        // Beispiel: /api/anfragen?sortBy=createdAt:desc  oder /api/anfragen?sortBy=EVU:asc
        if (queryParams.sortBy) {
            const parts = queryParams.sortBy.split(':');
            sortOptions[parts[0]] = parts[1] === 'desc' ? -1 : 1;
        } else {
            // Standard-Sortierung, falls nichts angegeben ist
            sortOptions.createdAt = -1; // Neueste zuerst
        }

        // Paginierungs-Logik (optional, für später)
        const page = parseInt(queryParams.page, 10) || 1;
        const limit = parseInt(queryParams.limit, 10) || 10; // Standard-Limit von 10
        const skip = (page - 1) * limit;

        const anfragen = await Anfrage.find(filter)
                                      .sort(sortOptions)
                                      .skip(skip)
                                      .limit(limit)
                                      .populate({ // Lade die Slot-Referenzen und deren Verweis auf den Topf
                                          path: 'ZugewieseneSlots.slot',
                                          select: 'VerweisAufTopf zugewieseneAnfragen'
                                      })
                                      .lean(); // .lean() für schnellere, reine JS-Objekte

        const totalAnfragen = await Anfrage.countDocuments(filter);

        // Schritt 2: Daten für jede Anfrage anreichern
        const anfragenMitStats = [];
        for (const anfrage of anfragen) {
            // Finde alle einzigartigen Kapazitätstöpfe, die dieser Anfrage zugeordnet sind
            const zugewieseneTopfIds = new Set();
            if (anfrage.ZugewieseneSlots) {
                anfrage.ZugewieseneSlots.forEach(zs => {
                    if (zs.slot && zs.slot.VerweisAufTopf) {
                        zugewieseneTopfIds.add(zs.slot.VerweisAufTopf.toString());
                    }
                });
            }

            // Finde offene Konflikte für diese Töpfe, an denen DIESE Anfrage beteiligt ist
            const topfKonflikte = await KonfliktDokumentation.countDocuments({
                konfliktTyp: 'KAPAZITAETSTOPF',
                status: { $ne: 'geloest' }, // z.B. 'offen', 'in_bearbeitung', etc.
                ausloesenderKapazitaetstopf: { $in: Array.from(zugewieseneTopfIds) },
                beteiligteAnfragen: anfrage._id
            });

            // Finde Slot-Konflikte (mehr als eine Zuweisung) für die Slots dieser Anfrage
            let slotKonfliktAnzahl = 0;
            if (anfrage.ZugewieseneSlots) {
                anfrage.ZugewieseneSlots.forEach(zs => {
                    // Prüfe, ob der Slot mehr als eine zugewiesene Anfrage hat
                    if (zs.slot && zs.slot.zugewieseneAnfragen && zs.slot.zugewieseneAnfragen.length > 1) {
                        slotKonfliktAnzahl++;
                    }
                });
            }

            anfragenMitStats.push({
                ...anfrage, // Alle ursprünglichen Anfrage-Daten
                statistik: { // Neues Objekt mit den berechneten Statistiken
                    anzahlZugewiesenerSlots: anfrage.ZugewieseneSlots?.length || 0,
                    anzahlKonfliktSlots: slotKonfliktAnzahl,
                    anzahlZugewiesenerToepfe: zugewieseneTopfIds.size,
                    anzahlKonfliktToepfe: topfKonflikte
                }
            });
        }


        res.status(200).json({
            message: 'Anfragen erfolgreich abgerufen.',
            data: anfragenMitStats,
            currentPage: page,
            totalPages: Math.ceil(totalAnfragen / limit),
            totalCount: totalAnfragen
        });

    } catch (error) {
        console.error('Fehler beim Abrufen der Anfragen:', error);
        res.status(500).json({ message: 'Serverfehler beim Abrufen der Anfragen.' });
    }
};

// @desc    Ruft eine einzelne Anfrage anhand ihrer ID ab
// @route   GET /api/anfragen/:anfrageId
exports.getAnfrageById = async (req, res) => {
    try {
        const anfrageIdParam = req.params.anfrageId;
        let queryConditions = [];

        // Bedingung für die Suche über AnfrageID_Sprechend hinzufügen
        queryConditions.push({ AnfrageID_Sprechend: anfrageIdParam });

        // Wenn der Parameter eine gültige MongoDB ObjectId ist, auch danach suchen
        if (mongoose.Types.ObjectId.isValid(anfrageIdParam)) {
            queryConditions.push({ _id: anfrageIdParam });
        }

        // Finde die Anfrage, die entweder der _id ODER der AnfrageID_Sprechend entspricht
        const anfrage = await Anfrage.findOne({ $or: queryConditions })
            .populate({
                path: 'ZugewieseneSlots.slot', // Greife auf das 'slot'-Feld im Array zu
                model: 'Slot', // Gib das Modell explizit an
                select: 'SlotID_Sprechend Linienbezeichnung Abschnitt VerweisAufTopf', // Wähle die Felder des Slots aus
                populate: { // Verschachteltes Populate für den Kapazitätstopf des Slots
                    path: 'VerweisAufTopf',
                    model: 'Kapazitaetstopf',
                    select: 'TopfID maxKapazitaet ListeDerAnfragen' // Wähle die Felder des Topfes aus
                }
            });

        if (!anfrage) {
            return res.status(404).json({ message: 'Anfrage nicht gefunden.' });
        }

        res.status(200).json({
            message: 'Anfrage erfolgreich abgerufen.',
            data: anfrage
        });

    } catch (error) {
        console.error('Fehler beim Abrufen der Anfrage anhand der ID:', error);
        // Spezifische Fehlerbehandlung für CastError, falls die ID trotz Prüfung Probleme macht
        if (error.name === 'CastError') {
            return res.status(400).json({ message: 'Ungültiges ID-Format.' });
        }
        res.status(500).json({ message: 'Serverfehler beim Abrufen der Anfrage.' });
    }
};

// NEUE FUNKTION: exports.updateAnfrage
exports.updateAnfrage = async (req, res) => {
    try {
        const anfrageIdParam = req.params.anfrageId;
        
        // Finde die Anfrage
        let queryConditions = [{ AnfrageID_Sprechend: anfrageIdParam }];
        if (mongoose.Types.ObjectId.isValid(anfrageIdParam)) {
            queryConditions.push({ _id: anfrageIdParam });
        }
        let anfrage = await Anfrage.findOne({ $or: queryConditions });

        if (!anfrage) {
            return res.status(404).json({ message: 'Anfrage nicht gefunden.' });
        }

        // Definiere, welche Felder aktualisiert werden dürfen (Korrektur durch Nutzer)
        const allowedUpdates = [
            'ListeGewuenschterSlotAbschnitte', 'Verkehrsart', 'Verkehrstag',
            'Zeitraum', 'Email', 'Entgelt'
        ];
        const updates = req.body;
        let anfrageWurdeGeaendert = false;

        for (const key in updates) {
            if (allowedUpdates.includes(key)) {
                // Tiefe Gleichheitsprüfung für Objekte/Arrays wäre hier besser,
                // aber für den Moment nehmen wir an, dass eine Änderung stattfindet, wenn der Key da ist.
                // Mongoose's anfrage.set() oder direkte Zuweisung und anfrage.markModified() ist robuster.
                anfrage[key] = updates[key];
                anfrageWurdeGeaendert = true;
                 // Wenn ein Feld geändert wird, das die Validierung beeinflusst, markieren.
                if (['ListeGewuenschterSlotAbschnitte', 'Verkehrsart', 'Zeitraum'].includes(key)) {
                    anfrage.markModified(key); // Wichtig für Mongoose, um die Änderung zu erkennen
                }
            }
        }

        // Wenn keine relevanten Felder geändert wurden (oder keine erlaubten Updates gesendet wurden),
        // könnte man hier die Anfrage unverändert zurückgeben oder einen Hinweis geben.
        // Für den Moment: Wenn relevante Felder geändert wurden, neu validieren.
        if (!anfrageWurdeGeaendert && Object.keys(updates).length > 0) {
             return res.status(400).json({ message: 'Keine erlaubten Felder für das Update angegeben oder keine Änderungen vorgenommen.' });
        }
        
        // Wenn Daten geändert wurden, die eine Neuvalidierung erfordern:
        const validationResult = validateAnfrageLogic({
            ListeGewuenschterSlotAbschnitte: anfrage.ListeGewuenschterSlotAbschnitte,
            Zeitraum: anfrage.Zeitraum,
            Verkehrsart: anfrage.Verkehrsart
        });

        anfrage.Validierungsfehler = validationResult.errors;
        anfrage.Status = validationResult.isValid ? 'validiert' : 'ungueltig';
        // Zeitstempel für `updatedAt` wird automatisch von Mongoose gesetzt.

        const aktualisierteAnfrage = await anfrage.save();

        res.status(200).json({
            message: 'Anfrage erfolgreich aktualisiert.',
            data: aktualisierteAnfrage
        });

    } catch (error) {
        console.error('Fehler beim Aktualisieren der Anfrage:', error);
        if (error.name === 'ValidationError') { // Mongoose Schema Validierungsfehler beim Speichern
            return res.status(400).json({ message: 'Schema-Validierungsfehler beim Speichern der Änderungen.', errors: Object.values(error.errors).map(e => e.message) });
        }
        if (error.name === 'CastError') {
            return res.status(400).json({ message: 'Ungültiges ID-Format oder fehlerhafte Daten im Update.' });
        }
        res.status(500).json({ message: 'Serverfehler beim Aktualisieren der Anfrage.' });
    }
};

// Funktion sucht die passenden Slots der Anfrage heraus und belegt sie mit Konflikt
exports.zuordneSlotsZuAnfrage = async (req, res) => {
    try {
        const anfrageIdParam = req.params.anfrageId;
        // ... (Anfrage laden und Status 'validiert' prüfen - Logik bleibt) ...
        let queryAnfrageConditions = [{ AnfrageID_Sprechend: anfrageIdParam }];
        if (mongoose.Types.ObjectId.isValid(anfrageIdParam)) {
            queryAnfrageConditions.push({ _id: anfrageIdParam });
        }
        const anfrage = await Anfrage.findOne({ $or: queryAnfrageConditions });

        if (!anfrage) { return res.status(404).json({ message: 'Anfrage nicht gefunden.' }); }
        if (anfrage.Status !== 'validiert') { return res.status(400).json({ message: `Anfrage hat Status '${anfrage.Status}', nicht 'validiert'.` }); }

        const { ListeGewuenschterSlotAbschnitte, Verkehrsart: anfrageVerkehrsart, Verkehrstag: anfrageVerkehrstagGruppe, Zeitraum } = anfrage;
        
        const anfrageStartDatum = parseISO(Zeitraum.start.toISOString()); // Sicherstellen, dass es Date-Objekte sind
        const anfrageEndDatum = parseISO(Zeitraum.ende.toISOString());

        const relevanteGlobalRelativeKWs = []; // Array für Nummern der KWs
        const startRelKW = getGlobalRelativeKW(anfrageStartDatum);
        const endRelKW = getGlobalRelativeKW(anfrageEndDatum);
        //console.log(`Relative Wochen von ${startRelKW} bis ${endRelKW}`);

        if (startRelKW === null || endRelKW === null || startRelKW > endRelKW) {
            return res.status(400).json({ message: `Anfrage hat ungültigen Zeitraum von KW ${startRelKW} bis ${endRelKW}.` });
        }
        for (let kw = startRelKW; kw <= endRelKW; kw++) {
            relevanteGlobalRelativeKWs.push(kw);
        }
        if (relevanteGlobalRelativeKWs.length === 0 && ListeGewuenschterSlotAbschnitte.length > 0) {
            return res.status(400).json({ message: `Anfrage hat keinen passenden Zeitraum von KW ${startRelKW} bis ${endRelKW} aber gewünschte Abschnitte ${ListeGewuenschterSlotAbschnitte}.` });
        }

        let zuzuweisendeSlotIdsSet = new Set(); // Sammelt String-IDs zur Vermeidung von Duplikaten
        let alleAbschnitteAbgedeckt = true;

        for (const gewuenschterAbschnitt of ListeGewuenschterSlotAbschnitte) {
            let patternFuerDiesenAbschnittMindestensEinmalGefunden = false;
            for (const globRelKW of relevanteGlobalRelativeKWs) {
                let zielSlotVerkehrstageFuerSlotSuche = [];
                if (anfrageVerkehrstagGruppe === 'täglich') {
                    zielSlotVerkehrstageFuerSlotSuche = ['Mo-Fr', 'Sa+So'];
                } else {
                    zielSlotVerkehrstageFuerSlotSuche = [anfrageVerkehrstagGruppe];
                }
                for (const slotVerkehrstag of zielSlotVerkehrstageFuerSlotSuche) {
                    //console.log(`${gewuenschterAbschnitt}, ${anfrageVerkehrsart}, KW ${globRelKW}, VT ${slotVerkehrstag}`);
                    const matchingSlots = await Slot.find({
                        von: gewuenschterAbschnitt.von,
                        bis: gewuenschterAbschnitt.bis,
                        'Abfahrt.stunde': gewuenschterAbschnitt.Abfahrtszeit.stunde,
                        'Abfahrt.minute': gewuenschterAbschnitt.Abfahrtszeit.minute,
                        'Ankunft.stunde': gewuenschterAbschnitt.Ankunftszeit.stunde,
                        'Ankunft.minute': gewuenschterAbschnitt.Ankunftszeit.minute,
                        Verkehrsart: anfrageVerkehrsart,
                        Kalenderwoche: globRelKW,
                        Verkehrstag: slotVerkehrstag
                    }).select('_id'); // Nur die IDs holen für die erste Sammlung

                    if (matchingSlots.length > 0) {
                        patternFuerDiesenAbschnittMindestensEinmalGefunden = true;
                        matchingSlots.forEach(slot => zuzuweisendeSlotIdsSet.add(slot._id.toString()));
                    }
                }
            }
            if (!patternFuerDiesenAbschnittMindestensEinmalGefunden) {
                alleAbschnitteAbgedeckt = false;
                anfrage.Validierungsfehler.push(`Für den Abschnitt ${gewuenschterAbschnitt.von} -> ${gewuenschterAbschnitt.bis} (Abf: ${gewuenschterAbschnitt.Abfahrtszeit.stunde}:${String(gewuenschterAbschnitt.Abfahrtszeit.minute).padStart(2, '0')}) konnten keine passenden Slot-Muster gefunden werden.`);
            }
        }

        if (!alleAbschnitteAbgedeckt || (zuzuweisendeSlotIdsSet.size === 0 && ListeGewuenschterSlotAbschnitte.length > 0)) {
            anfrage.Status = 'zuordnung_fehlgeschlagen';
            await anfrage.save();
            return res.status(404).json({ message: 'Zuordnung fehlgeschlagen: Nicht für alle gewünschten Abschnitte konnten passende Slots gefunden werden.', fehlerDetails: anfrage.Validierungsfehler, data: anfrage });
        }

        // Konvertiere das Set von String-IDs zu einem Array von ObjectId-Instanzen
        const finaleSlotObjectIdsFuerAnfrage = Array.from(zuzuweisendeSlotIdsSet).map(idStr => new mongoose.Types.ObjectId(idStr));

        // anfrage.ZugewieseneSlots mit neuer Struktur befüllen
        anfrage.ZugewieseneSlots = finaleSlotObjectIdsFuerAnfrage.map(slotObjectId => ({
            slot: slotObjectId, // Hier die ObjectId verwenden
            statusEinzelzuweisung: 'initial_in_konfliktpruefung_topf'
        }));
        anfrage.markModified('ZugewieseneSlots');

        anfrage.Status = 'in_konfliktloesung_topf';
        anfrage.Validierungsfehler = anfrage.Validierungsfehler.filter(err => !err.startsWith("Für den Abschnitt"));

        // Entgelt berechnen
        if (anfrage.ZugewieseneSlots.length > 0) {
            // Für die Entgeltberechnung benötigen wir die Details der zugewiesenen Slots.
            // Die finaleSlotObjectIdsFuerAnfrage enthalten die _id's der relevanten Slot-Muster.
            const populatedZugewieseneSlots = await Slot.find({ 
                '_id': { $in: finaleSlotObjectIdsFuerAnfrage } 
            }).select('Grundentgelt von bis Abschnitt Verkehrsart Abfahrt Ankunft Kalenderwoche Verkehrstag'); // Alle relevanten Felder für calculateAnfrageEntgelt und dessen Helfer

            // Das 'anfrage'-Objekt, das wir an calculateAnfrageEntgelt übergeben,
            // hat jetzt bereits die neue Struktur von ZugewieseneSlots (Array von Objekten),
            // aber calculateAnfrageEntgelt erwartet die *populierten* Slot-Details als zweiten Parameter.
            anfrage.Entgelt = await calculateAnfrageEntgelt(anfrage, populatedZugewieseneSlots);
        } else {
            anfrage.Entgelt = 0;
            // Wenn keine Slots zugewiesen werden konnten, wurde der Status schon oben auf 'zuordnung_fehlgeschlagen' gesetzt.
        }
        console.log(`Entgelt für Anfrage ${anfrage.AnfrageID_Sprechend || anfrage._id} berechnet: ${anfrage.Entgelt}`);
        
        const gespeicherteAnfrage = await anfrage.save(); // Speichert Anfrage mit Entgelt und neuer Struktur von ZugewieseneSlots

        // Bidirektionale Verknüpfungen aktualisieren (Slot.zugewieseneAnfragen und Kapazitaetstopf.ListeDerAnfragen)
        if (finaleSlotObjectIdsFuerAnfrage.length > 0) {
            await Slot.updateMany(
                { _id: { $in: finaleSlotObjectIdsFuerAnfrage } },
                { $addToSet: { zugewieseneAnfragen: gespeicherteAnfrage._id } }
            );

            // Kapazitätstöpfe aktualisieren
            const slotsMitTopfReferenz = await Slot.find({ 
                _id: { $in: finaleSlotObjectIdsFuerAnfrage },
                VerweisAufTopf: { $exists: true, $ne: null }
            }).select('VerweisAufTopf');
            
            const betroffeneTopfIds = new Set();
            slotsMitTopfReferenz.forEach(s => {
                if(s.VerweisAufTopf) betroffeneTopfIds.add(s.VerweisAufTopf.toString());
            });

            if (betroffeneTopfIds.size > 0) {
                await Kapazitaetstopf.updateMany(
                    { _id: { $in: Array.from(betroffeneTopfIds).map(id => new mongoose.Types.ObjectId(id)) } },
                    { $addToSet: { ListeDerAnfragen: gespeicherteAnfrage._id } }
                );
                console.log(`Kapazitätstöpfe [${Array.from(betroffeneTopfIds).join(', ')}] mit Anfrage ${gespeicherteAnfrage.AnfrageID_Sprechend || gespeicherteAnfrage._id} aktualisiert.`);
            }
        }
        
        res.status(200).json({
            message: 'Slots erfolgreich der Anfrage zugeordnet, Entgelt berechnet. Anfrage ist nun in Konfliktprüfung.',
            data: gespeicherteAnfrage
        });

    } catch (error) {
        console.error('Fehler beim Zuordnen der Slots zur Anfrage:', error);
        // Fehlerbehandlung für anfrageBeiFehler.save()
        try {
            const anfrageIdParam = req.params.anfrageId;
            let queryAnfrageConditions = [{ AnfrageID_Sprechend: anfrageIdParam }];
            if (mongoose.Types.ObjectId.isValid(anfrageIdParam)) {
                queryAnfrageConditions.push({ _id: anfrageIdParam });
            }
            const anfrageBeiFehler = await Anfrage.findOne({ $or: queryAnfrageConditions }); // Finde die Original-Anfrage
            if(anfrageBeiFehler){ // Nur wenn die Anfrage gefunden wurde
                anfrageBeiFehler.Status = 'zuordnung_technischer_fehler';
                anfrageBeiFehler.Validierungsfehler.push(`Serverfehler bei Zuordnung: ${error.message}`);
                await anfrageBeiFehler.save();
            }
        } catch (saveError){
            console.error("Konnte Anfrage-Status nach Zuordnungsfehler nicht aktualisieren:", saveError);
        }
        res.status(500).json({ message: 'Serverfehler beim Zuordnen der Slots.' });
    }
};

// @desc    Liefert eine aggregierte Zusammenfassung aller Anfragen nach EVU, Verkehrsart und Status
// @route   GET /api/anfragen/summary
exports.getAnfrageSummary = async (req, res) => {
    try {
        const summary = await Anfrage.aggregate([
            // Stufe 1: Gruppiere alle Dokumente nach Verkehrsart UND EVU.
            {
                $group: {
                    _id: {
                        verkehrsart: "$Verkehrsart",
                        evu: "$EVU"
                    },
                    totalAnfragen: { $sum: 1 }, // Zähle die Gesamtzahl der Anfragen in dieser Gruppe
                    // Sammle alle Statuswerte dieser Gruppe in einem Array
                    statusListe: { $push: "$Status" } 
                }
            },
            // Stufe 2: Formatiere die Ausgabe und zähle die Vorkommen jedes Status.
            {
                $project: {
                    _id: 0,
                    verkehrsart: "$_id.verkehrsart",
                    evu: "$_id.evu",
                    totalAnfragen: 1,
                    statusCounts: { // Erzeuge ein Objekt mit den Zählerständen pro Status
                        validiert: {
                            $size: { $filter: { input: "$statusListe", cond: { $eq: ["$$this", "validiert"] } } }
                        },
                        inKonflikt: { // Fasst alle "in Arbeit"-Status zusammen
                            $size: { $filter: { input: "$statusListe", cond: { $in: ["$$this", ['in_konfliktloesung_topf', 'in_konfliktloesung_slot', 'teilweise_bestaetigt_topf']] } } }
                        },
                        bestaetigt: {
                            $size: { $filter: { input: "$statusListe", cond: { $eq: ["$$this", "vollstaendig_final_bestaetigt"] } } }
                        },
                        abgelehnt: {
                            $size: { $filter: { input: "$statusListe", cond: { $eq: ["$$this", "final_abgelehnt"] } } }
                        },
                        // Man könnte hier noch weitere Status-Gruppen hinzufügen
                    }
                }
            },
            // Stufe 3: Sortiere das Endergebnis
            {
                $sort: {
                    verkehrsart: 1,
                    evu: 1
                }
            }
        ]);

        res.status(200).json({
            message: 'Zusammenfassung der Anfragen erfolgreich abgerufen.',
            data: summary
        });

    } catch (error) {
        console.error('Fehler bei der Erstellung der Anfragen-Zusammenfassung:', error);
        res.status(500).json({ message: 'Serverfehler bei der Erstellung der Zusammenfassung.' });
    }
};