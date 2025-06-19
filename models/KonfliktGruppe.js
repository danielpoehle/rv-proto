// models/KonfliktGruppe.js
const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const konfliktGruppeSchema = new Schema({
    // _id wird automatisch von MongoDB generiert und dient als unsere stabile gruppenId

    gruppenSchluessel: { 
        // Der sortierte, kommaseparierte String der Anfrage-IDs.
        // Dient zur schnellen Identifizierung, ob für eine Anfrage-Kombination schon eine Gruppe existiert.
        type: String, 
        required: true, 
        unique: true, 
        index: true 
    },
    beteiligteAnfragen: [{ 
        type: Schema.Types.ObjectId, 
        ref: 'Anfrage' 
    }],
    konflikteInGruppe: [{ // Referenzen auf die einzelnen KonfliktDokumentation-Objekte
        type: Schema.Types.ObjectId, 
        ref: 'KonfliktDokumentation' 
    }],
    status: {
        type: String,
        required: true,
        enum: [
            'offen',                          // Alle Einzelkonflikte sind 'offen'
            'in_bearbeitung_verzicht',        // Alle Einzelkonflikte sind 'in_bearbeitung' (vor Verzicht)
            'in_bearbeitung_entgelt',         // Alle Einzelkonflikte sind 'in_bearbeitung_entgelt'
            'in_bearbeitung_hoechstpreis',    // Alle Einzelkonflikte sind 'in_bearbeitung_hoechstpreis'
            'vollstaendig_geloest',           // Alle Einzelkonflikte sind 'geloest'
            'invalide'                        // Die Einzelkonflikte haben unterschiedliche Status
        ],
        default: 'offen'
    },
    notizen: String // Notizen, die sich auf die gesamte Gruppe beziehen
}, { timestamps: true });

module.exports = mongoose.model('KonfliktGruppe', konfliktGruppeSchema);