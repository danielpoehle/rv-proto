const express = require('express');
const router = express.Router();
const kapazitaetstopfController = require('../controllers/kapazitaetstopfController');

// --- Routen für die gesamte Collection (/api/kapazitaetstoepfe) ---
router.route('/')
    .get(kapazitaetstopfController.getAllKapazitaetstoepfe) // Handler für GET /
    .post(kapazitaetstopfController.createKapazitaetstopf); // Handler für POST /

// --- Spezifische Sub-Routen (kommen vor den dynamischen Routen) ---
router.route('/summary')
    .get(kapazitaetstopfController.getKapazitaetstopfSummary); // Handler für GET /summary


// --- Routen für ein spezifisches Dokument (/api/kapazitaetstoepfe/:topfId) ---
// Wichtig: Diese dynamische Route kommt nach allen statischen Routen.
router.route('/:topfIdOderMongoId')
    .get(kapazitaetstopfController.getKapazitaetstopfById)      // Handler für GET /:id
    .put(kapazitaetstopfController.updateKapazitaetstopf)      // Handler für PUT /:id
    .delete(kapazitaetstopfController.deleteKapazitaetstopf);  // Handler für DELETE /:id
    // Hinweis: Ich habe den Parameter einheitlich auf ':topfIdOderMongoId' gesetzt für Konsistenz.
    // Bitte stelle sicher, dass du in deinen Controllern dann auch `req.params.topfIdOderMongoId` verwendest.

// --- Spezifische Aktionen für ein Dokument ---
//router.route('/:topfIdOderMongoId/slots')
//    .put(kapazitaetstopfController.setSlotsForKapazitaetstopf)      // Handler für PUT /:id/slots
//    .post(kapazitaetstopfController.addSingleSlotToKapazitaetstopf); // Handler für POST /:id/slots

module.exports = router;