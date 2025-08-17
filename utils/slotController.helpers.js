const mongoose = require('mongoose');
const Kapazitaetstopf = require('../models/Kapazitaetstopf');
const kapazitaetstopfService = require('../utils/kapazitaetstopf.service');
const { TagesSlot } = require('../models/Slot');


// Hilfsfunktion: Findet oder erstellt einen Kapazitätstopf basierend auf Slot-Kriterien
async function findOrCreateKapazitaetstopf(slotData) {
    //console.log(slotData);
    const { 
            slotTyp, // 'TAG' oder 'NACHT'
            Abschnitt, Verkehrstag, 
            Kalenderwoche,
            // Tag-spezifisch:
            Abfahrt, Verkehrsart,
            // Nacht-spezifisch:
            Zeitfenster
        } = slotData;
    
    let passendesZeitfenster = Zeitfenster;
    if(slotTyp === 'TAG'){
        passendesZeitfenster = TagesSlot.mapAbfahrtstundeToKapazitaetstopfZeitfenster(Abfahrt.stunde);
    }    

    let slotVerkehrsart = Verkehrsart;
    if(!slotVerkehrsart){ slotVerkehrsart = 'ALLE'; }

    if (!passendesZeitfenster || !Abschnitt || !Verkehrstag || !Kalenderwoche) return null;

    // 1. Versuche, Topf mit spezifischer Verkehrsart am Tag zu finden
    let topf = await Kapazitaetstopf.findOne({
        Abschnitt, Kalenderwoche, Verkehrstag,
        Zeitfenster: passendesZeitfenster, Verkehrsart: slotVerkehrsart
    });    

    // 2. Wenn nicht gefunden, erstelle einen neuen Topf
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
};


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
};

module.exports = {
    updateTopfSlotsAndCapacity,
    findOrCreateKapazitaetstopf
};