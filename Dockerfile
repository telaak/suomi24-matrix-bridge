FROM node:18-alpine as base

WORKDIR /app
COPY . .
RUN apk add --no-cache gcompat libc6-compat
RUN npm i
RUN npx tsc

FROM node:18-alpine as runner
WORKDIR /app
COPY --from=base ./app/dist ./dist
COPY package*.json ./
ENV NODE_ENV production
RUN apk add --no-cache gcompat libc6-compat
RUN npm i

EXPOSE 9000

CMD [ "node", "./dist/index.js", "-p 9000" ]