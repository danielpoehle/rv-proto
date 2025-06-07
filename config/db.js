const mongoose = require('mongoose');
//require('dotenv').config(); // Ist in server.js global, könnte hier aber auch spezifisch sein

const connectDB = async () => {
  try {
    let dbUri = process.env.MONGODB_URI; // Aus .env für dev/prod

    if (process.env.NODE_ENV === 'test') {
      // Für Tests, verbinde dich mit dem Docker-Container oder einer anderen Test-DB
      dbUri = process.env.TEST_MONGO_URI || 'mongodb://localhost:27017/test-mongo-slots';
      console.log("Running in TEST environment, connecting to Dockerized MongoDB or TEST_MONGO_URI.");
    }

    if (!dbUri) {
      throw new Error('Datenbank-URI nicht definiert.');
    }
    const conn = await mongoose.connect(dbUri);
    console.log(`MongoDB Connected: ${conn.connection.host}`);
  } catch (error) {
    console.error(`Error connecting to MongoDB: ${error.message}`);
    process.exit(1);
  }
};

module.exports = connectDB;