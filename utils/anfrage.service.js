const mongoose = require('mongoose');
const Anfrage = require('../models/Anfrage');
const Slot = require('../models/Slot');
const Kapazitaetstopf = require('../models/Kapazitaetstopf');
const KonfliktDokumentation = require('../models/KonfliktDokumentation');
const { parseISO, getDay, eachDayOfInterval, startOfWeek } = require('date-fns');
const { getGlobalRelativeKW } = require('../utils/date.helpers'); 
const { UTCDate } = require('@date-fns/utc');


// --- HILFSFUNKTIONEN (aus anfrageController.js hierher verschoben) ---
const GLOBAL_KW1_START_DATE_ISO = "2024-12-30T00:00:00.000Z";
const GLOBAL_KW1_START_DATE = startOfWeek(parseISO(GLOBAL_KW1_START_DATE_ISO), { weekStartsOn: 1 });

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

/**
 * SERVICE-FUNKTION: Führt den gesamten Zuordnungsprozess für eine einzelne Anfrage durch.
 * @param {string|ObjectId} anfrageId - Die ID der zuzuordnenden Anfrage.
 * @returns {Promise<Anfrage>} Das aktualisierte und gespeicherte Anfrage-Objekt.
 * @throws {Error} Wirft einen Fehler, wenn die Anfrage nicht gefunden wird, nicht valide ist oder keine Slots zugeordnet werden können.
 */
async function fuehreAnfrageZuordnungDurch(anfrageId) {
    const anfrage = await Anfrage.findById(anfrageId);

    if (!anfrage) { throw new Error(`Anfrage mit ID ${anfrageId} nicht gefunden.`); }
        
    if (anfrage.Status !== 'validiert') { throw new Error(`Anfrage ${anfrage.AnfrageID_Sprechend || anfrageId} hat nicht den Status 'validiert' (aktueller Status: ${anfrage.Status}).`); }

    const { ListeGewuenschterSlotAbschnitte, Verkehrsart: anfrageVerkehrsart, Verkehrstag: anfrageVerkehrstagGruppe, Zeitraum } = anfrage;
        
    const anfrageStartDatum = parseISO(Zeitraum.start.toISOString()); // Sicherstellen, dass es Date-Objekte sind
    const anfrageEndDatum = parseISO(Zeitraum.ende.toISOString());

    const relevanteGlobalRelativeKWs = []; // Array für Nummern der KWs
    const startRelKW = getGlobalRelativeKW(anfrageStartDatum);
    const endRelKW = getGlobalRelativeKW(anfrageEndDatum);
    //console.log(`Relative Wochen von ${startRelKW} bis ${endRelKW}`);

    if (startRelKW === null || endRelKW === null || startRelKW > endRelKW) {
        anfrage.Status = 'zuordnung_fehlgeschlagen';
        anfrage.Validierungsfehler.push('Anfragezeitraum ungültig für globale KW-Berechnung.');
        await anfrage.save();
        throw new Error('Anfragezeitraum ungültig für globale KW-Berechnung.');
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
        throw new Error('Zuordnung fehlgeschlagen: Nicht für alle gewünschten Abschnitte konnten passende Slots gefunden werden.');
    }

    // Konvertiere das Set von String-IDs zu einem Array von ObjectId-Instanzen
    const finaleSlotObjectIdsFuerAnfrage = Array.from(zuzuweisendeSlotIdsSet).map(idStr => new mongoose.Types.ObjectId(idStr));

    // anfrage.ZugewieseneSlots mit neuer Struktur befüllen
    anfrage.ZugewieseneSlots = finaleSlotObjectIdsFuerAnfrage.map(slotObjectId => ({
        slot: slotObjectId, // Hier die ObjectId verwenden
        statusEinzelzuweisung: 'initial_in_konfliktpruefung_topf'
    }));
    anfrage.markModified('ZugewieseneSlots');

    anfrage.Status = 'in_konfliktpruefung';
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

    return gespeicherteAnfrage;
}

/**
 * SETZT EINE ANFRAGE-ZUORDNUNG ZURÜCK: Entfernt alle zugewiesenen Slots,
 * setzt das Entgelt zurück und aktualisiert alle bidirektionalen Verknüpfungen.
 * @param {string|ObjectId} anfrageId - Die ID der zurückzusetzenden Anfrage.
 * @returns {Promise<Document>} Das aktualisierte Anfrage-Objekt.
 */
async function resetAnfrageZuordnung(anfrageId) {
    // 1. Lade die Anfrage mit allen relevanten Details
    const anfrage = await Anfrage.findById(anfrageId).populate({
        path: 'ZugewieseneSlots.slot',
        select: 'VerweisAufTopf'
    });

    if (!anfrage) throw new Error(`Anfrage mit ID ${anfrageId} nicht gefunden.`);

    // 2a. Sicherheitsprüfung: Ist die Anfrage in einem zurücksetzbaren Zustand?
    // Erlaubt sind nur Status, die noch keinen unumkehrbaren Konfliktlösungsschritt durchlaufen haben.
    const erlaubteResetStatus = [
        'initial_in_konfliktpruefung_topf',
        'bestaetigt_topf', // Wenn Topf konfliktfrei war, aber noch keine Slot-Konflikte geprüft wurden
        'bestaetigt_slot' // etc.
    ];
    const kannZurueckgesetztWerden = anfrage.ZugewieseneSlots.every(zs => 
        erlaubteResetStatus.includes(zs.statusEinzelzuweisung)
    );

    // 2b. Sicherheitsprüfung: Zähle, in wie vielen Konfliktdokumenten diese Anfrage als beteiligt geführt wird.
    const anzahlKonflikte = await KonfliktDokumentation.countDocuments({
        beteiligteAnfragen: anfrage._id
    });

    if (!kannZurueckgesetztWerden || anzahlKonflikte > 0) {
        throw new Error(`Anfrage ${anfrage.AnfrageID_Sprechend || anfrageId} kann nicht zurückgesetzt werden, da sie bereits bei ${anzahlKonflikte} Konflikt(en) in einem fortgeschrittenen Konfliktlösungsprozess ist. Bitte zuerst den/die Konflikt(e) über die Gruppen-Bearbeitung zurücksetzen.`);
    }

    // 3. Sammle die IDs der zu bereinigenden Slots und Töpfe, BEVOR wir sie löschen
    if (anfrage.ZugewieseneSlots && anfrage.ZugewieseneSlots.length > 0) {
        const slotIdsToClean = anfrage.ZugewieseneSlots.map(zs => zs.slot._id);
        const topfIdsToClean = new Set(
            anfrage.ZugewieseneSlots
                .map(zs => zs.slot?.VerweisAufTopf?.toString())
                .filter(Boolean) // Entferne null/undefined
        );

        // 4. Bereinige die bidirektionalen Verknüpfungen
        // Entferne die Anfrage-ID aus allen betroffenen Slots
        await Slot.updateMany(
            { _id: { $in: slotIdsToClean } },
            { $pull: { zugewieseneAnfragen: anfrage._id } }
        );
        console.log(`Anfrage ${anfrage._id} aus ${slotIdsToClean.length} Slots entfernt.`);

        // Entferne die Anfrage-ID aus allen betroffenen Kapazitätstöpfen
        if (topfIdsToClean.size > 0) {
            await Kapazitaetstopf.updateMany(
                { _id: { $in: Array.from(topfIdsToClean) } },
                { $pull: { ListeDerAnfragen: anfrage._id } }
            );
            console.log(`Anfrage ${anfrage._id} aus ${topfIdsToClean.size} Kapazitätstöpfen entfernt.`);
        }
    }

    // 5. Setze die Anfrage selbst zurück
    anfrage.ZugewieseneSlots = [];
    anfrage.Entgelt = null;
    anfrage.Status = 'validiert'; // Zurück zum Status vor der Zuordnung
    anfrage.Validierungsfehler = []; // Ggf. alte Zuordnungsfehler löschen

    anfrage.save();

    return anfrage;
}

module.exports = {
    fuehreAnfrageZuordnungDurch,
    resetAnfrageZuordnung
    // Hier könnten später weitere Service-Funktionen für Anfragen hinzukommen
};