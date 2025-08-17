const { TagesSlot, NachtSlot } = require('../models/Slot');
const { findOrCreateKapazitaetstopf, updateTopfSlotsAndCapacity } = require('../utils/slotController.helpers');

/**
 * Erstellt ein einzelnes Slot-Dokument (Tag oder Nacht), generiert die sprechende ID,
 * findet/erstellt den zugehörigen Kapazitätstopf und aktualisiert die Verknüpfungen.
 * @param {object} slotData - Die Daten für den zu erstellenden Slot. Muss `slotTyp` ('TAG' oder 'NACHT') enthalten.
 * @returns {Promise<Document>} Das erstellte und gespeicherte Slot-Dokument.
 */
async function createSingleSlot(slotData) {
    // 1. Finde oder erstelle den passenden Kapazitätstopf
    const potenziellerTopf = await findOrCreateKapazitaetstopf(slotData);
    
    const dataToSave = {
        ...slotData,
        VerweisAufTopf: potenziellerTopf ? potenziellerTopf._id : null
    };

    // 2. Erstelle die korrekte Instanz basierend auf dem Typ
    let neuerSlot;
    if (slotData.slotTyp === 'NACHT') {
        neuerSlot = new NachtSlot(dataToSave);
    } else { // 'TAG' ist der Standard
        neuerSlot = new TagesSlot(dataToSave);
    }

    // 3. Speichern (löst den pre-save Hook für die SlotID_Sprechend aus)
    const gespeicherterSlot = await neuerSlot.save();

    // 4. Bidirektionale Verknüpfung im Kapazitätstopf aktualisieren
    if (gespeicherterSlot.VerweisAufTopf) {
        await updateTopfSlotsAndCapacity(gespeicherterSlot.VerweisAufTopf, gespeicherterSlot._id, 'add');
    }

    //console.log("finished function createSingleSlot")

    return gespeicherterSlot;
}

module.exports = {
    createSingleSlot
};