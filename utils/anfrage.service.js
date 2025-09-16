const mongoose = require('mongoose');
const Anfrage = require('../models/Anfrage');
const {Slot, TagesSlot, NachtSlot} = require('../models/Slot');
const Kapazitaetstopf = require('../models/Kapazitaetstopf');
const KonfliktDokumentation = require('../models/KonfliktDokumentation');
const { parseISO, getDay, eachDayOfInterval, startOfWeek } = require('date-fns');
const { getGlobalRelativeKW } = require('../utils/date.helpers'); 
const { UTCDate } = require('@date-fns/utc');


// --- HILFSFUNKTIONEN (aus anfrageController.js hierher verschoben) ---
const GLOBAL_KW1_START_DATE_ISO = "2024-12-30T00:00:00.000Z";
const GLOBAL_KW1_START_DATE = startOfWeek(parseISO(GLOBAL_KW1_START_DATE_ISO), { weekStartsOn: 1 });

// Hilfsfunktion: Konvertiert {stunde, minute} zu Minuten seit Mitternacht
// dayOffset: Anzahl Stunden wegen Tageswechsel
const timeToMinutes = (timeObj, dayOffset) => {
    return((timeObj.stunde + dayOffset) * 60 + timeObj.minute);
}

function mapAbfahrtstundeToKapazitaetstopfZeitfenster(stunde) {
    if (stunde === undefined || stunde === null || stunde < 0 || stunde > 23) return null;

    if (stunde >= 5 && stunde <= 6) return '05-07';
    if (stunde >= 7 && stunde <= 8) return '07-09';
    if (stunde >= 9 && stunde <= 10) return '09-11';
    if (stunde >= 11 && stunde <= 12) return '11-13';
    if (stunde >= 13 && stunde <= 14) return '13-15';
    if (stunde >= 15 && stunde <= 16) return '15-17';
    if (stunde >= 17 && stunde <= 18) return '17-19';
    if (stunde >= 19 && stunde <= 20) return '19-21';
    if (stunde >= 21 && stunde <= 22) return '21-23';
    if (stunde === 23 || stunde === 0) return '23-01'; // Stunde 0 (Mitternacht) für das 23-01 Fenster
    if (stunde >= 1 && stunde <= 2) return '01-03';
    if (stunde >= 3 && stunde <= 4) return '03-05';
    return null; // Sollte nicht erreicht werden bei validen Stunden 0-23
}

function generateOffset(ListeGewuenschterSlotAbschnitte) {
    let dayOffset = 0;
    for (let i = 0; i < ListeGewuenschterSlotAbschnitte.length; i++) {
        const currentSegment = ListeGewuenschterSlotAbschnitte[i];
        const nextSegment = ListeGewuenschterSlotAbschnitte[i + 1]; 

        //Wenn (mehrfacher) Tageswechsel detektiert wurde, dann speichern wir das Offset
        ListeGewuenschterSlotAbschnitte[i].dayOffset = dayOffset;
        //console.log(`i ${i} dayoffset ${dayOffset}`);

        const abfahrtAktuellMinuten = timeToMinutes(currentSegment.Abfahrtszeit, dayOffset);
        const ankunftAktuellMinuten = timeToMinutes(currentSegment.Ankunftszeit, dayOffset);

        //console.log(`current segment abfahrtAktuellMinuten ${abfahrtAktuellMinuten} ankunftAktuellMinuten ${ankunftAktuellMinuten}`);

        if (ankunftAktuellMinuten < abfahrtAktuellMinuten) {
            dayOffset += 24;
            //Tageswechsel detektiert  
            //console.log("Tageswechsel im aktuellen Segment detektiert.");        
        } 
        
        if (nextSegment) {
            const abfahrtNaechsterMinuten = timeToMinutes(nextSegment.Abfahrtszeit, dayOffset);
            //console.log(`to next segment ankunftAktuellMinuten ${ankunftAktuellMinuten} abfahrtNaechsterMinuten ${abfahrtNaechsterMinuten}`);

                if(abfahrtNaechsterMinuten < ankunftAktuellMinuten){
                    dayOffset += 24;
                    //console.log("Tageswechsel zum nachfolgenden Segment detektiert."); 
                    //Tageswechsel detektiert 
                }
        }
    }

    return ListeGewuenschterSlotAbschnitte;
}

function berechneFahrzeit(gewuenschterAbschnitt){
    let fz = (60 * gewuenschterAbschnitt.Ankunftszeit.stunde + gewuenschterAbschnitt.Ankunftszeit.minute) - (60 * gewuenschterAbschnitt.Abfahrtszeit.stunde + gewuenschterAbschnitt.Abfahrtszeit.minute);
    if(fz < 0){fz = fz + 24*60;}
    return fz;
}

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

    //console.log(`gesamtBetriebstageAnfrage ${gesamtBetriebstageAnfrage}`);

    let summeGrundentgelteProDurchlauf = 0;

    //console.log(anfrage);
    //console.log(`zugewieseneSlotsPopulated ${zugewieseneSlotsPopulated}`);

    // Schritt 2: Ermittle die Summe der Grundentgelte für EINEN kompletten Durchlauf der Anfrage.
    // Ein Durchlauf besteht aus allen Segmenten in anfrage.ListeGewuenschterSlotAbschnitte.
    for (const gewuenschterAbschnitt of anfrage.ListeGewuenschterSlotAbschnitte) {
        // Finde ein repräsentatives zugewiesenes Slot-Muster (aus einer beliebigen KW,
        // da wir annehmen, das Grundentgelt für diesen Slot-Typ ist über KWs hinweg gleich),
        // das den Eigenschaften des gewünschten Abschnitts entspricht.
        const passendesSlotDetail = zugewieseneSlotsPopulated.find(s => {

            //console.log(gewuenschterAbschnitt);
            //console.log(s);

            if(s.slotTyp === 'TAG'){
                const vonMatch = s.von === gewuenschterAbschnitt.von;
                const bisMatch = s.bis === gewuenschterAbschnitt.bis;
                const vaMatch = s.Verkehrsart === anfrage.Verkehrsart; 
                const abfHMatch = s.Abfahrt.stunde === gewuenschterAbschnitt.Abfahrtszeit.stunde;
                const abfMMatch = s.Abfahrt.minute === gewuenschterAbschnitt.Abfahrtszeit.minute;
                const ankHMatch = s.Ankunft.stunde === gewuenschterAbschnitt.Ankunftszeit.stunde;
                const ankMMatch = s.Ankunft.minute === gewuenschterAbschnitt.Ankunftszeit.minute;
                //console.log(`vonMatch ${vonMatch} bisMatch ${bisMatch} vaMatch ${vaMatch} abfHMatch ${abfHMatch} abfMMatch ${abfMMatch} ankHMatch ${ankHMatch} ankMMatch ${ankMMatch}`)
                return vonMatch && bisMatch && vaMatch && abfHMatch && abfMMatch && ankHMatch && ankMMatch;
            }else{
                const vonMatch = s.von === gewuenschterAbschnitt.von;
                const bisMatch = s.bis === gewuenschterAbschnitt.bis;
                const vaMatch = s.Verkehrsart === 'ALLE';
                const zfMatch = s.Zeitfenster === mapAbfahrtstundeToKapazitaetstopfZeitfenster(gewuenschterAbschnitt.Abfahrtszeit.stunde);
                return vonMatch && bisMatch && vaMatch && zfMatch;
            }           
        }
        );
        
        //console.log(zugewieseneSlotsPopulated);
        //console.log(gewuenschterAbschnitt);
        //console.log(passendesSlotDetail);

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

    const { Verkehrsart: anfrageVerkehrsart, Verkehrstag: anfrageVerkehrstagGruppe, Zeitraum } = anfrage;
    let { ListeGewuenschterSlotAbschnitte } = anfrage;    

    //Falls die SlotAbschnitte noch keine Prüfung auf Tageswechsel durchlaufen haben, wird dayOffset ergänzt
    //console.log(ListeGewuenschterSlotAbschnitte);
    ListeGewuenschterSlotAbschnitte = generateOffset(ListeGewuenschterSlotAbschnitte);
    //console.log(ListeGewuenschterSlotAbschnitte);
        
    const anfrageStartDatum = parseISO(Zeitraum.start.toISOString()); // Sicherstellen, dass es Date-Objekte sind
    const anfrageEndDatum = parseISO(Zeitraum.ende.toISOString());

    const relevanteGlobalRelativeKWs = []; // Array für Nummern der KWs
    const startRelKW = getGlobalRelativeKW(anfrageStartDatum);
    const endRelKW = getGlobalRelativeKW(anfrageEndDatum);
    //console.log(`Relative Wochen von ${Zeitraum.start.toISOString()} -> ${anfrageStartDatum.toISOString()} in KW${startRelKW} bis ${Zeitraum.ende.toISOString()} -> ${anfrageEndDatum.toISOString()} in KW${endRelKW}`);

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
    // Definiere die Nachtstunden für die Prüfung
    const nachtStunden = new Set([23, 0, 1, 2, 3, 4]);

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
                const istNachtSuche = nachtStunden.has(gewuenschterAbschnitt.Abfahrtszeit.stunde);
                let matchingSlots = [];
                let nightOverlapSlots = [];

                // Zusätzlich zum Tages- bzw. Nacht-Slot muss bei Tageswechsel am Morgen (Abfahrt.stunde === 0) der 
                // Slot des Vortages für den alternierenden Verkehrstag und am Abend (Abfahrt.stunde >== 1 und dayOffset > 0)
                // der Slot des Folgetages für den alternierenden Verkehrstag mit belegt werden
                // Zusätzlich muss bei Tageswechsel am Morgen bei Mo-Fr der Sa+So der Vorwoche belegt werden
                // Bei Tageswechsel am Abend bei Sa+So muss der Mo-Fr der Folgewoche belegt werden
                // Bedeutet konkret bei VT Mo-Fr: 
                // ------------ ist Abfahrt.stunde === 0 und dayOffset === 0 wird zusätzlich Sa+So in globRelKW-1 belegt
                // ------------ ist Abfahrt.stunde >== 1 und dayOffset >   0 wird zusätzlich Sa+So in globRelKW belegt
                // Bedeutet konkret bei VT Sa+So:
                // ------------ ist Abfahrt.stunde === 0 und dayOffset === 0 wird zusätzlich Mo-Fr in globRelKW belegt
                // ------------ ist Abfahrt.stunde >== 1 und dayOffset >   0 wird zusätzlich Mo-Fr in globRelKW+1 belegt

                if(istNachtSuche){
                    matchingSlots = await NachtSlot.find({
                    von: gewuenschterAbschnitt.von,
                    bis: gewuenschterAbschnitt.bis,
                    Zeitfenster: mapAbfahrtstundeToKapazitaetstopfZeitfenster(gewuenschterAbschnitt.Abfahrtszeit.stunde),
                    Verkehrsart: 'ALLE',
                    Kalenderwoche: globRelKW,
                    Verkehrstag: slotVerkehrstag
                    }).select('_id Mindestfahrzeit Maximalfahrzeit'); // Nur die IDs und Fahrzeitspanne
                    if(slotVerkehrstag === 'Mo-Fr' && gewuenschterAbschnitt.Abfahrtszeit.stunde === 0 && gewuenschterAbschnitt.dayOffset === 0){
                        nightOverlapSlots = await NachtSlot.find({
                        von: gewuenschterAbschnitt.von,
                        bis: gewuenschterAbschnitt.bis,
                        Zeitfenster: mapAbfahrtstundeToKapazitaetstopfZeitfenster(gewuenschterAbschnitt.Abfahrtszeit.stunde),
                        Verkehrsart: 'ALLE',
                        Kalenderwoche: globRelKW-1,
                        Verkehrstag: 'Sa+So'
                        }).select('_id Mindestfahrzeit Maximalfahrzeit'); // Nur die IDs und Fahrzeitspanne
                    }
                    if(slotVerkehrstag === 'Mo-Fr' && gewuenschterAbschnitt.Abfahrtszeit.stunde > 0 && gewuenschterAbschnitt.dayOffset > 0){
                        nightOverlapSlots = await NachtSlot.find({
                        von: gewuenschterAbschnitt.von,
                        bis: gewuenschterAbschnitt.bis,
                        Zeitfenster: mapAbfahrtstundeToKapazitaetstopfZeitfenster(gewuenschterAbschnitt.Abfahrtszeit.stunde),
                        Verkehrsart: 'ALLE',
                        Kalenderwoche: globRelKW,
                        Verkehrstag: 'Sa+So'
                        }).select('_id Mindestfahrzeit Maximalfahrzeit'); // Nur die IDs und Fahrzeitspanne
                    }
                    if(slotVerkehrstag === 'Sa+So' && gewuenschterAbschnitt.Abfahrtszeit.stunde === 0 && gewuenschterAbschnitt.dayOffset === 0){
                        nightOverlapSlots = await NachtSlot.find({
                        von: gewuenschterAbschnitt.von,
                        bis: gewuenschterAbschnitt.bis,
                        Zeitfenster: mapAbfahrtstundeToKapazitaetstopfZeitfenster(gewuenschterAbschnitt.Abfahrtszeit.stunde),
                        Verkehrsart: 'ALLE',
                        Kalenderwoche: globRelKW,
                        Verkehrstag: 'Mo-Fr'
                        }).select('_id Mindestfahrzeit Maximalfahrzeit'); // Nur die IDs und Fahrzeitspanne
                    }
                    if(slotVerkehrstag === 'Sa+So' && gewuenschterAbschnitt.Abfahrtszeit.stunde > 0 && gewuenschterAbschnitt.dayOffset > 0){
                        nightOverlapSlots = await NachtSlot.find({
                        von: gewuenschterAbschnitt.von,
                        bis: gewuenschterAbschnitt.bis,
                        Zeitfenster: mapAbfahrtstundeToKapazitaetstopfZeitfenster(gewuenschterAbschnitt.Abfahrtszeit.stunde),
                        Verkehrsart: 'ALLE',
                        Kalenderwoche: globRelKW+1,
                        Verkehrstag: 'Mo-Fr'
                        }).select('_id Mindestfahrzeit Maximalfahrzeit'); // Nur die IDs und Fahrzeitspanne
                    }
                }else {
                    matchingSlots = await TagesSlot.find({
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
                    if(slotVerkehrstag === 'Mo-Fr' && gewuenschterAbschnitt.Abfahrtszeit.stunde > 4 && gewuenschterAbschnitt.dayOffset > 0){
                        nightOverlapSlots = await TagesSlot.find({
                        von: gewuenschterAbschnitt.von,
                        bis: gewuenschterAbschnitt.bis,
                        'Abfahrt.stunde': gewuenschterAbschnitt.Abfahrtszeit.stunde,
                        'Abfahrt.minute': gewuenschterAbschnitt.Abfahrtszeit.minute,
                        'Ankunft.stunde': gewuenschterAbschnitt.Ankunftszeit.stunde,
                        'Ankunft.minute': gewuenschterAbschnitt.Ankunftszeit.minute,
                        Verkehrsart: anfrageVerkehrsart,
                        Kalenderwoche: globRelKW,
                        Verkehrstag: 'Sa+So'
                        }).select('_id'); // Nur die IDs holen für die erste Sammlung
                    }
                    if(slotVerkehrstag === 'Sa+So' && gewuenschterAbschnitt.Abfahrtszeit.stunde > 4 && gewuenschterAbschnitt.dayOffset > 0){
                        nightOverlapSlots = await TagesSlot.find({
                        von: gewuenschterAbschnitt.von,
                        bis: gewuenschterAbschnitt.bis,
                        'Abfahrt.stunde': gewuenschterAbschnitt.Abfahrtszeit.stunde,
                        'Abfahrt.minute': gewuenschterAbschnitt.Abfahrtszeit.minute,
                        'Ankunft.stunde': gewuenschterAbschnitt.Ankunftszeit.stunde,
                        'Ankunft.minute': gewuenschterAbschnitt.Ankunftszeit.minute,
                        Verkehrsart: anfrageVerkehrsart,
                        Kalenderwoche: globRelKW+1,
                        Verkehrstag: 'Mo-Fr'
                        }).select('_id'); // Nur die IDs holen für die erste Sammlung
                    }
                }

                if (matchingSlots.length > 0) {
                    if (istNachtSuche) {
                        // Bei Nacht-Slots: Finde den ERSTEN passenden Slot, dessen Fahrzeit-Range stimmt.
                        const wunschfahrzeit = berechneFahrzeit(gewuenschterAbschnitt); 

                        const ersterPassenderNachtSlot = matchingSlots.find(slot =>
                            wunschfahrzeit >= slot.Mindestfahrzeit && wunschfahrzeit <= slot.Maximalfahrzeit);

                        if (ersterPassenderNachtSlot) {
                            // Es wurde ein passender Nacht-Slot gefunden
                            patternFuerDiesenAbschnittMindestensEinmalGefunden = true;
                            zuzuweisendeSlotIdsSet.add(ersterPassenderNachtSlot._id.toString());
                        } else {
                            // Es wurden zwar Nacht-Slots für das Zeitfenster gefunden,
                            // aber bei keinem passte die Fahrzeit.
                            anfrage.Validierungsfehler.push(`Für den Abschnitt ${gewuenschterAbschnitt.von} -> ${gewuenschterAbschnitt.bis} liegt die gewünschte Fahrzeit (Nacht) nicht im zulässigen Bereich der verfügbaren Slots.`);
                            // In diesem Fall wird `patternFuerDiesenAbschnittMindestensEinmalGefunden` nicht `true` gesetzt,
                            // was dazu führt, dass die Anfrage später als 'zuordnung_fehlgeschlagen' markiert wird.
                        }
                        if(nightOverlapSlots.length > 0){
                            const ersterPassenderOverlapSlot = nightOverlapSlots.find(slot =>
                            wunschfahrzeit >= slot.Mindestfahrzeit && wunschfahrzeit <= slot.Maximalfahrzeit);
                            if(ersterPassenderOverlapSlot){
                                // Es wurde ein passender Nacht-Slot gefunden
                                zuzuweisendeSlotIdsSet.add(ersterPassenderOverlapSlot._id.toString());
                            }else {
                                // Es wurden zwar Nacht-Slots für das Zeitfenster gefunden,
                                // aber bei keinem passte die Fahrzeit.
                                anfrage.Validierungsfehler.push(`Für den Abschnitt ${gewuenschterAbschnitt.von} -> ${gewuenschterAbschnitt.bis} liegt die gewünschte Fahrzeit für den Slot im Nachtsprung (Nacht) nicht im zulässigen Bereich der verfügbaren Slots.`);
                            }
                        }
                    } else {
                        // Bei Tages-Slots: Nimm einfach den ERSTEN gefundenen Slot.
                        patternFuerDiesenAbschnittMindestensEinmalGefunden = true;
                        zuzuweisendeSlotIdsSet.add(matchingSlots[0]._id.toString());
                        if(nightOverlapSlots.length > 0){
                            zuzuweisendeSlotIdsSet.add(nightOverlapSlots[0]._id.toString());
                        }
                    }
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

    // Konvertiere das Set von String-IDs der Kind-Slots zu einem Array von ObjectId-Instanzen
    const finaleSlotObjectIdsFuerAnfrage = Array.from(zuzuweisendeSlotIdsSet).map(idStr => new mongoose.Types.ObjectId(idStr));

    // 1. Lade die vollen Kind-Slots, um an deren Eltern-Referenz zu kommen
    const kindSlots = await Slot.find({ _id: { $in: finaleSlotObjectIdsFuerAnfrage } }).select('gabelElternSlot');

    // 2. Erstelle die neue, detaillierte `ZugewieseneSlots`-Liste für die Anfrage
    // anfrage.ZugewieseneSlots mit neuer Struktur befüllen
    anfrage.ZugewieseneSlots = kindSlots.map(kindSlot => ({
        slot: kindSlot.gabelElternSlot, // Referenz auf den ELTERN-Slot
        kind: kindSlot._id,              // Referenz auf den KIND-Slot
        statusEinzelzuweisung: 'initial_in_konfliktpruefung_topf'
    }));
    anfrage.markModified('ZugewieseneSlots');

    anfrage.Status = 'in_konfliktpruefung';
    anfrage.Validierungsfehler = anfrage.Validierungsfehler.filter(err => !err.startsWith("Für den Abschnitt"));

    // 3. Sammle alle beteiligten Eltern- und Kind-IDs für die Aktualisierung
    const elternSlotIds = new Set(kindSlots.map(k => k.gabelElternSlot.toString()));


    // Entgelt berechnen
    if (anfrage.ZugewieseneSlots.length > 0) {
        // Für die Entgeltberechnung benötigen wir die Details der zugewiesenen Slots.
        // Die finaleSlotObjectIdsFuerAnfrage enthalten die _id's der relevanten Slot-Muster.
        const slotDocs = await Slot.find({ 
            '_id': { $in: finaleSlotObjectIdsFuerAnfrage } 
        }).select('Grundentgelt von bis Abschnitt Verkehrsart Abfahrt Ankunft Kalenderwoche Verkehrstag Zeitfenster slotTyp'); // Alle relevanten Felder für calculateAnfrageEntgelt und dessen Helfer

        // Konvertiere die Mongoose-Dokumente in einfache JavaScript-Objekte.
        // Dadurch wird sichergestellt, dass alle Eigenschaften direkt verfügbar sind.
        const populatedZugewieseneSlots = slotDocs.map(doc => doc.toObject());
        
        // Das 'anfrage'-Objekt, das wir an calculateAnfrageEntgelt übergeben,
        // hat jetzt bereits die neue Struktur von ZugewieseneSlots (Array von Objekten),
        // aber calculateAnfrageEntgelt erwartet die *populierten* Slot-Details als zweiten Parameter.
        anfrage.Entgelt = await calculateAnfrageEntgelt(anfrage, populatedZugewieseneSlots);
    } else {
        anfrage.Entgelt = 0;
        // Wenn keine Slots zugewiesen werden konnten, wurde der Status schon oben auf 'zuordnung_fehlgeschlagen' gesetzt.
    }
    //console.log(`Entgelt für Anfrage ${anfrage.AnfrageID_Sprechend || anfrage._id} berechnet: ${anfrage.Entgelt}`);
        
    const gespeicherteAnfrage = await anfrage.save(); // Speichert Anfrage mit Entgelt und neuer Struktur von ZugewieseneSlots

    // Bidirektionale Verknüpfungen aktualisieren (Slot.zugewieseneAnfragen und Kapazitaetstopf.ListeDerAnfragen)
    // Füge die Anfrage-ID zu ALLEN beteiligten Slots (Eltern UND Kinder) hinzu
    if (finaleSlotObjectIdsFuerAnfrage.length > 0) {
        await Slot.updateMany(
            { _id: { $in: [...finaleSlotObjectIdsFuerAnfrage, ...Array.from(elternSlotIds)] } },
            { $addToSet: { zugewieseneAnfragen: gespeicherteAnfrage._id } }
        );

        // Kapazitätstöpfe aktualisieren (basierend auf den Eltern-Slots)
        const slotsMitTopfReferenz = await Slot.find({ 
            _id: { $in: Array.from(elternSlotIds) },
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
            //console.log(`Kapazitätstöpfe [${Array.from(betroffeneTopfIds).join(', ')}] mit Anfrage ${gespeicherteAnfrage.AnfrageID_Sprechend || gespeicherteAnfrage._id} aktualisiert.`);
        }
    }

    console.log(`Anfrage ${gespeicherteAnfrage.AnfrageID_Sprechend || gespeicherteAnfrage._id} zugeordnet und in Datenbank aktualisiert`)
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
        'bestaetigt_slot', // Wenn Slot direkt konfliktfrei war
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