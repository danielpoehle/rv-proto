FROM node:21-alpine3.20
WORKDIR /app
COPY . .

RUN npm install
RUN wget https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem

CMD ["npm", "run", "dev"]