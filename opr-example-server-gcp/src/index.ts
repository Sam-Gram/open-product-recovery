/**
 * Copyright 2022 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * A fake example server.
 */
import {
  generateKeys,
  LocalJwksProvider,
  LocalKeySigner,
  log,
  OprServer,
  OrgConfigProvider,
  RegexpUrlMapper,
  StaticFeedConfigProvider,
  UniversalAcceptListingPolicy,
  StaticServerAccessControlList,
  FakeOfferProducer,
  OfferChange,
  CustomRequestHandler,
} from 'opr-core';
import yargs from 'yargs';
import * as dotenv from 'dotenv';
log.setLevel('WARN');
import {
  DataSourceOptions,
  PostgresTestingLauncher,
  SqlOprDatabase,
} from 'opr-sql-database';
import {
  CloudStorageJwksProvider,
  CloudStorageKeySigner,
  IamCustomEndpointWrapper,
} from 'opr-google-cloud';

// Import any local environment variables from .env
dotenv.config();
const args = yargs
  .usage('Usage: $0 [options]')
  .example('$0', 'Run the server and initialize the database')
  .option('initdb', {
    type: 'string',
    describe:
      'Whether to COMPLETELY ERASE AND RE-CREATE the database on ' +
      'startup. Ignored unless the value is "yes".',
  })
  .option('dbhost', {
    type: 'string',
    describe:
      'Database hostname to use. Defaults to DB_HOST env variable value.',
  })
  .option('dbname', {
    type: 'string',
    describe:
      'Database name to use. Defaults to DB_NAME env variable value,' +
      ' or "postgres" if no env variable is specified.',
  })
  .option('dbuser', {
    type: 'string',
    describe:
      'Database user to use. Defaults to DB_USER env variable value,' +
      ' or "postgres" if no env variable is specified.',
  })
  .option('dbpassword', {
    type: 'string',
    describe:
      'Database password to use. Defaults to DB_PASSWORD env variable value.',
  })
  .option('port', {
    type: 'number',
    describe:
      'Server port. Defaults to PORT env variable or 5000 if no env variable ' +
      'is specified',
  })
  .option('serviceaccount', {
    type: 'string',
    describe:
      'Service account email address to use for this server. Defaults to ' +
      'OPR_SERVICE_ACCOUNT env variable. This is the only account that can ' +
      'make calls to the ingest/ endpoint',
  })
  .option('hostname', {
    type: 'string',
    describe:
      'Hostname to use for this server. Defaults to OPR_HOSTNAME env variable' +
      ' or localhost is no env variable is specified.',
  })
  .option('gcspublickeyspath', {
    type: 'string',
    describe:
      'Path to a GCS folder containing public encryption keys. Defaults to ' +
      'GCS_PUBLIC_KEYS_PATH env variable.',
  })
  .option('gcsprivatekeypath', {
    type: 'string',
    describe:
      'Path to a GCS folder containing the private encryption key. Defaults ' +
      'to GCS_PRIVATE_KEY_PATH env variable.',
  })
  .parseSync();

// We need a main method because we want to use the "await" keyword,
// and it's not allowed in top-level script code. But we can declare an
// async main method and immediately call it.
async function main() {
  console.log('Starting server...', args.initdb);
  // Let's put together all the pieces of a working server.

  let envVarPort = process.env.PORT ? parseInt(process.env.PORT) : undefined;
  if (envVarPort !== undefined && isNaN(envVarPort)) {
    envVarPort = undefined;
  }
  const port = args.port ?? envVarPort ?? 5000;

  const hostname = args.hostname ?? process.env.OPR_HOSTNAME ?? 'localhost';

  // Create an org config provider with the url mapper we configured above. This
  // way, org configuration information will be fetched from local servers
  // instead of the public org url.
  const orgConfigProvider = new OrgConfigProvider();

  // Create a frontend configuration. This tells the server how to create the
  // organization config file, and how to map its contents to server endpoints.
  const frontendConfig = {
    // Replace with your organization name
    name: 'ExampleServer',
    // Replace with your organization's public org descriptor URL
    organizationURL: `${hostname}/org.json`,
    orgFilePath: '/org.json',
    jwksURL: '/jwks.json',
    listProductsPath: '/api/list',
    acceptProductPath: '/api/accept',
    rejectProductPath: '/api/list',
    reserveProductPath: '/api/list',
    historyPath: '/api/list',
  };

  // Create an access control list that allows us to control which organizations
  // can talk to this server.
  const accessControlList = new StaticServerAccessControlList(['*']);

  // Create a public keyset provider to return the public keys.
  const publicKeysPath =
    args.gcspublickeyspath ?? process.env.GCS_PUBLIC_KEYS_PATH;
  if (!publicKeysPath) {
    throw new Error('Cannot start server without public keys');
  }
  const jwksProvider = new CloudStorageJwksProvider(publicKeysPath);

  const privateKeyPath =
    args.gcsprivatekeypath ?? process.env.GCS_PRIVATE_KEY_PATH;
  if (!privateKeyPath) {
    throw new Error('Cannot start server without a private key');
  }
  // Create a Signer that can use the private keys to create tokens.
  const signer = new CloudStorageKeySigner(
    frontendConfig.organizationURL,
    privateKeyPath
  );

  // Create a feed config provider so we can fetch a list of feed configurations
  const feedConfigProvider = new StaticFeedConfigProvider([
    // Uncomment below to read from other servers.
    // {
    //   organizationUrl: 'https://opr.yetanotherexamplehost.org/org.json',
    //   maxUpdateFrequencyMillis: 1000,
    // },
  ]);
  // Create a listing policy so that we know how to list ingested offers to
  // other servers.
  const listingPolicy = new UniversalAcceptListingPolicy(['*']);
  const database = new SqlOprDatabase({
    dsOptions: getDbOptions(),
    listingPolicy: listingPolicy,
    signer: signer,
    hostOrgUrl: frontendConfig.organizationURL,
    enableInternalChecks: true,
  });

  // We create a fake offer producer. Replace this with an offer producer that
  // reads from your inventory system to publish new offers.
  const offerProducer = new FakeOfferProducer({
    sourceOrgUrl: frontendConfig.organizationURL,
    database: database,
    updateFrequencyMillis: 3000,
    newItemFrequencyMillis: 10000,
  });

  // Create a custom endpoint that will call server.ingest() to pull in any
  // new offers, and return any changes that occurred.
  // NOTE: For a real server, you probably want to require some authentication
  // to call this endpoint. Otherwise bad guys might hammer your server with
  // ingest() requests.
  const ingestEndpoint = {
    method: ['POST'],
    handle: async () => {
      const changes = [] as Array<OfferChange>;
      const changeHandler = database.registerChangeHandler(async change => {
        changes.push(change);
      });
      await s.ingest();
      changeHandler.remove();
      return changes;
    },
  } as CustomRequestHandler;

  // Create a custom debug endpoint that will return the list of ALL offers on
  // this server.
  // ADD AUTHENTICATION TO AN ENDPOINT LIKE THIS! This is exposing all offers
  // on your server to anyone that calls this endpoint. For a real server,
  // only admins and developers should be able to see this information.
  // Organizations should only see offers that are listed for them.
  const allOffersEndpoint = {
    method: ['GET', 'POST'],
    handle: async () => {
      return await database.getAllOffers();
    },
  } as CustomRequestHandler;

  const oprServiceAccount =
    args.serviceaccount ?? process.env.OPR_SERVICE_ACCOUNT;
  // Now we have all the pieces to start our server.
  const s = new OprServer({
    frontendConfig: frontendConfig,
    orgConfigProvider: orgConfigProvider,
    database: database,
    jwksProvider: jwksProvider,
    signer: signer,
    accessControlList: accessControlList,
    producers: [offerProducer],
    customHandlers: {
      ingest: IamCustomEndpointWrapper.wrap(ingestEndpoint, {
        isAllowed: async (email: string) => {
          return email === oprServiceAccount;
        },
      }),
      allOffers: allOffersEndpoint,
    },
  });
  s.start(port);
}
main();

function getDbOptions(): DataSourceOptions {
  const options = {
    type: 'postgres',
    host: args.dbhost ?? process.env.DB_HOST,
    database: args.dbname ?? process.env.DB_NAME ?? 'postgres',
    username: args.dbuser ?? process.env.DB_USER ?? 'postgres',
    password: args.dbpassword ?? process.env.DB_PASSWORD,
    synchronize: args.initdb === 'yes',
    dropSchema: args.initdb === 'yes',
  } as DataSourceOptions;
  return options;
}
