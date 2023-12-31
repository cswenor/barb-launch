const algosdk = require('algosdk');
const fs = require('fs');


// Base URL for the NFD API
const baseURL = "https://api.nf.domains/nfd/";

const indexerToken = "";
const indexerServer = "https://mainnet-idx.algonode.cloud";
const indexerPort = "";
const indexerClient = new algosdk.Indexer(indexerToken, indexerServer, indexerPort);

const asaID = "1285225688"; // Your ASA ID for Barb
const senderAddress = "RPC35543V7YH6WTWYWBKIYITLYG2DT3BZD6WEZFR4TXZY3EGA6CKRZKZN4";

const blacklistedAddresses = [
  "RPC35543V7YH6WTWYWBKIYITLYG2DT3BZD6WEZFR4TXZY3EGA6CKRZKZN4",
  "MLFVS7JYC5S7TEWUWDY5HHJTCS3EHWV6KZKOM43Q2RSCX6VZH7DEBJXZYQ",
  "3Q2VUSSZ7WSAYEHZYZAPHMCKZLNVXC2YRR62K5YA327UOJ3MZJOIAKOLLQ"
];



// Function to fetch segments
async function fetchSegments(appID) {
  let allSegments = [];
  let offset = 0;
  const limit = 200; // The API's limit per call

  try {
    let isMoreData = true;
    while (isMoreData) {
      let url = `${baseURL}v2/search?parentAppID=${appID}&limit=${limit}&offset=${offset}&sort=createdDesc&view=brief`;
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      let data = await response.json();

      if (data.nfds && data.nfds.length > 0) {
        allSegments = allSegments.concat(data.nfds); // Adding the segments from the current fetch to the total array
      }

      offset += limit; // Increase the offset for the next call

      // Check if we've fetched all the segments
      isMoreData = data.total > allSegments.length;
    }
  } catch (error) {
    console.error("An error occurred while fetching segments:", error);
  }

  return allSegments;
}

function removeBlacklistedAddresses(ownerDetails) {
  blacklistedAddresses.forEach(address => {
      if (ownerDetails[address]) {
          delete ownerDetails[address];
      }
  });
  return ownerDetails;
}

// Function to combine duplicate addresses and add counts
function countOwners(segments) {
  const ownerCounts = {};
  segments.forEach(segment => {
      const owner = segment.owner;
      if (owner && !blacklistedAddresses.includes(owner)) {
          if (!ownerCounts[owner]) {
              ownerCounts[owner] = 1;
          } else {
              ownerCounts[owner] += 1;
          }
      }
  });
  return ownerCounts;
}

function calculateTotalBarb(ownerCounts) {
  const barbAmountPerOwner = 45745.65416;
  const ownerDetails = {};

  for (const owner in ownerCounts) {
    const count = ownerCounts[owner];
    ownerDetails[owner] = {
      count: count,
      totalBarb: count * barbAmountPerOwner
    };
  }

  return ownerDetails;
}

async function fetchTransactionsFromSender() {
  try {
    const response = await indexerClient.lookupAccountTransactions(senderAddress)
                                         .assetID(asaID)
                                         .currencyGreaterThan(0)
                                         .do();
    return response.transactions || [];
  } catch (error) {
    console.error(`An error occurred while fetching transactions:`, error);
    return [];
  }
}

async function calculateReceivedBarb(ownerDetails) {
  const transactions = await fetchTransactionsFromSender();

  transactions.forEach(transaction => {
    if (transaction['asset-transfer-transaction'] && transaction['sender'] === senderAddress) {
      const receiver = transaction['asset-transfer-transaction']['receiver'];
      const amount = transaction['asset-transfer-transaction']['amount'];

      const actualAmount = amount / Math.pow(10, 6);

      if (receiver in ownerDetails) {
        if (!ownerDetails[receiver]['receivedBarb']) {
          ownerDetails[receiver]['receivedBarb'] = 0;
        }
        ownerDetails[receiver]['receivedBarb'] += actualAmount;
      }
    }
  });

  return ownerDetails;
}

function calculateTotalSupposedBarb(ownerDetails) {
  let totalSupposedBarb = 0;
  for (const owner in ownerDetails) {
    if (!blacklistedAddresses.includes(owner) && ownerDetails.hasOwnProperty(owner)) {
      totalSupposedBarb += ownerDetails[owner].totalBarb;
    }
  }
  return totalSupposedBarb;
}

function calculateTotalReceivedBarb(ownerDetails) {
  let totalReceivedBarb = 0;
  for (const owner in ownerDetails) {
    if (!blacklistedAddresses.includes(owner) && ownerDetails.hasOwnProperty(owner)) {
      totalReceivedBarb += ownerDetails[owner].receivedBarb || 0;
    }
  }
  return totalReceivedBarb;
}


function calculateDeltas(ownerDetails) {
  for (const owner in ownerDetails) {
    if (ownerDetails.hasOwnProperty(owner)) {
      const totalBarbSupposed = ownerDetails[owner].totalBarb;
      const receivedBarb = ownerDetails[owner].receivedBarb || 0; // Default to 0 if undefined

      // Calculate the delta
      const delta = totalBarbSupposed - receivedBarb;

      // Add the delta to the ownerDetails object
      ownerDetails[owner].deltaBarb = delta;
    }
  }

  return ownerDetails;
}

function removeZeroDeltas(ownerDetails) {
  for (const owner in ownerDetails) {
    if (ownerDetails.hasOwnProperty(owner)) {
      // Check if the delta is 0 (considering floating-point precision)
      if (Math.abs(ownerDetails[owner].deltaBarb) < Number.EPSILON) {
        delete ownerDetails[owner]; // Remove the entry
      }
    }
  }

  return ownerDetails;
}

function sumAllDeltas(ownerDetails) {
  let totalDelta = 0;

  for (const owner in ownerDetails) {
    if (ownerDetails.hasOwnProperty(owner)) {
      totalDelta += ownerDetails[owner].deltaBarb; // Accumulate the deltas
    }
  }

  return totalDelta;
}

async function findNonNFDTransactions(ownerDetails) {
  const nfdOwners = new Set(Object.keys(ownerDetails)); // Create a set for faster lookup
  const allTransactions = await fetchTransactionsFromSender(); // Fetch all transactions from the sender

  // Filter transactions where the receiver is not in the NFD owners list
  const nonNFDTransactions = allTransactions.filter(transaction => {
    if (transaction['asset-transfer-transaction']) {
      const receiver = transaction['asset-transfer-transaction']['receiver'];
      return !nfdOwners.has(receiver);
    }
    return false;
  });

  return nonNFDTransactions;
}

function convertToCSV(ownerDetails) {
  // Define the CSV columns and header
  const headers = ["Owner Address", "Count", "Total Supposed Barb", "Received Barb", "Delta Barb"];
  const rows = [headers.join(',')]; // Start with headers

  // Loop through the owner details to create the CSV rows
  for (const owner in ownerDetails) {
      if (ownerDetails.hasOwnProperty(owner)) {
          const detail = ownerDetails[owner];
          const row = [
              owner, // Owner Address
              detail.count || 0, // Count
              detail.totalBarb || 0, // Total Supposed Barb
              detail.receivedBarb || 0, // Received Barb
              detail.deltaBarb || 0 // Delta Barb
          ];
          rows.push(row.join(',')); // Join each row's values with commas and push
      }
  }

  // Join all rows with newline characters to create the full CSV string
  return rows.join('\n');
}


async function main() {
  try {
    // Step 1: Fetch the segments
    const segments = await fetchSegments('1282363795');

    // Step 2: Combine duplicates and add counts
    const ownerCounts = countOwners(segments);

    const cleanedOwnerDetails = removeBlacklistedAddresses(ownerCounts);

    // Step 3: Calculate the total Barb for each owner
    const totalBarb = calculateTotalBarb(cleanedOwnerDetails);

    // Calculate the total Barb that was supposed to be given out
    const totalSupposedBarb = calculateTotalSupposedBarb(totalBarb);

    // Step 4: Calculate the received Barb for each owner
    const ownerDetails = await calculateReceivedBarb(totalBarb);

    // Calculate the total amount of Barb actually given out
    const totalReceivedBarb = calculateTotalReceivedBarb(ownerDetails);
    

    // Step 5: Calculate the deltas
    const detailsWithDeltas = calculateDeltas(ownerDetails);

    // Step 6: Remove addresses with a delta of 0
    const finalDetails = removeZeroDeltas(detailsWithDeltas);

    // Step 7: Calculate the sum of all deltas
    const totalDeltaSum = sumAllDeltas(finalDetails);

    console.log("Final details:", finalDetails);
    console.log("Total Barb supposed to be given out:", totalSupposedBarb);
    console.log("Total Barb actually given out:", totalReceivedBarb);
    console.log("Total sum of all deltas:", totalDeltaSum);

    // const nonNFDTransactions = await findNonNFDTransactions(cleanedOwnerDetails);
    // console.log("Transactions not to NFDs:", nonNFDTransactions);

    const csvData = convertToCSV(finalDetails);

    // Define the path and name of the file
    const filePath = 'barb_distribution_analysis.csv';

    // Write the CSV data to a file
    fs.writeFile(filePath, csvData, (err) => {
        if (err) {
            console.error('An error occurred while writing the CSV file:', err);
        } else {
            console.log(`CSV file was saved as ${filePath}`);
        }
    });


  } catch (error) {
    console.error("An error occurred:", error);
  }
}

main();

