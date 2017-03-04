#!/usr/bin/env node

const trainline = require('./trainline.js');
const program = require('commander');
const prompt = require('prompt');
const storage = require('node-persist');
const colors = require('colors');
const moment = require('moment');
const Table = require('cli-table2');
const fuzzy = require('fuzzy');
const inquirer = require('inquirer');
inquirer.registerPrompt('autocomplete', require('inquirer-autocomplete-prompt'));

// Connected user infos
var uinfos;

// Prompt global configuration
prompt.message = '';
prompt.delimiter = '';
prompt.colors = false;

// storage configuration
storage.init({
  stringify: JSON.stringify,
  parse: JSON.parse,
  encoding: 'utf8',
  ttl: false
}).then(() => {
  storage.getItem('uinfos').then(function(infos) {
    if (infos && infos.meta && infos.meta.token) {
      trainline.TOKEN = infos.meta.token;
      uinfos = infos;
      console.log(colors.yellow('Welcome ' + uinfos.user.first_name + ' ' + uinfos.user.last_name + '!'));
    }
    main();
  });
});

program
  .version('1.0.0')
  .option('-l, --login [email]', 'Log in to your Trainline account')
  .option('-L, --logout', 'Logout of your Trainline account')
  .option('-s, --search', 'Search for a trip')
  .option('-t, --trips', 'List of your trips')
  .option('-b, --basket', 'List of your options')
  .parse(process.argv);

function main() {
  // Login
  if (program.login) {
    prompt.start();
    prompt.get({
      properties: {
        password: {
          hidden: true,
          description: "Trainline password:"
        }
      }
    }, function (err, result) {
      if (err || !result || !result.password) {
        console.log('Please enter your password');
        return;
      }
      trainline.connexion(program.login, result.password).then(infos => {
        uinfos = infos;
        return storage.setItem('uinfos', infos);
      }).then(() => {
        console.log(colors.blue('You are now connected as ' + uinfos.user.first_name + ' ' + uinfos.user.last_name + '!'));
      }).catch(err => {
        console.log(colors.red('Wrong password or wrong email address'));
      });
    });
    return;
  }

  // The following actions need a user to be connected
  if (!uinfos) {
    console.log('You are not connected. Use --login [email]');
    return;
  }

  // Logout
  if (program.logout) {
    storage.removeItem('uinfos').then(() => {
      console.log('You are now disconnected');
    });
  }

  if (program.trips) {
    console.log('List of your trips');
    trainline.trips().then(trips => {
      console.log(tripsToTable(trips.slice(0, 7)));
    });
  }

  if (program.basket) {
    console.log('Content of your basket');
    trainline.basket().then(trips => {
      console.log(tripsToTable(trips));
    });
  }

  if (program.search) {
    let dates = getNextDays(90);

    inquirer.prompt([
      {
        type: 'autocomplete',
        name: 'from',
        suggestOnly: false,
        message: 'From:',
        source: searchStation,
        pageSize: 5
      },
      {
        type: 'autocomplete',
        name: 'to',
        suggestOnly: false,
        message: 'To:',
        source: searchStation,
        pageSize: 5
      },
      {
        type: 'autocomplete',
        name: 'departure_date',
        suggestOnly: false,
        message: 'Departure date:',
        source: (answers, input) => {
          return Promise.resolve(fuzzy.filter(input || '', dates).map(e => { return e.string }));
        },
        pageSize: 5
      },
      {
        type: 'list',
        name: 'hour',
        message: 'Time:',
        choices: ['14h', '16h', '18h', '20h', '22h', '6h', '8h', '10h', '12h']
      },
      {
        type: 'checkbox',
        name: 'passenger_ids',
        message: 'Passengers:',
        choices: uinfos.passengers.map(passenger => {
          return {
            checked: passenger.is_selected,
            name: passenger.first_name + ' ' + passenger.last_name,
            value: passenger.id
          }
        }).sort((a, b) => {
          return a.checked;
        })
      }
    ]).then(answers => {
      // We need to find the ids of the selected stations
      let sq1 = trainline.searchStation(answers.from);
      let sq2 = trainline.searchStation(answers.to);
      return Promise.all([answers, sq1, sq2]);
    }).then(queries => {
      let answers = queries[0];
      let departure_station_id = queries[1][0].id;
      let arrival_station_id = queries[2][0].id;
      let departure_date = moment(colors.strip(answers.departure_date) + ' ' + answers.hour, 'dddd, MMMM D H[h]').format();
      let passenger_ids = answers.passenger_ids;

      return trainline.searchTrips(departure_station_id, arrival_station_id, passenger_ids, departure_date);
    }).then(trips => {
      trips = humanifyTrips(trips);
      let choices = [];
      choices.push(new inquirer.Separator());
      trips.forEach(trip => {
        let table = new Table({ chars: { 'top': '' , 'top-mid': '' , 'top-left': '' , 'top-right': ''
         , 'bottom': '' , 'bottom-mid': '' , 'bottom-left': '' , 'bottom-right': ''
         , 'left': '' , 'left-mid': '' , 'mid': '' , 'mid-mid': ''
         , 'right': '' , 'right-mid': '' , 'middle': ' ' },
  style: { 'padding-left': 0, 'padding-right': 0 }, colWidths: [20, 100] });
        let duration = formatDuration(moment(trip.arrival_date) - moment(trip.departure_date));
        let departure_time = moment(trip.departure_date).format('HH:mm');
        let arrival_time = moment(trip.arrival_date).format('HH:mm');
        let price = trip.travel_classes.economy.cents/100;
        if (trip.travel_classes.first) {
          price += ' / ' + trip.travel_classes.first.cents/100;
        }
        price += ' ' + trip.travel_classes.economy.currency;
        table.push([duration, departure_time + '  ' + trip.departure_station]);
        trip.stops.forEach(stop => {
          table.push(['  ', '      ' + formatDuration(stop.duration) + '  ' + stop.station]);
        });
        table.push(['  ' + price, '  ' + arrival_time + '  ' + trip.arrival_station]);

        choices.push({
          name: table.toString(),
          value: trip.travel_classes,
          short: trip.departure_station + ' ' + departure_time + ' > ' + arrival_time + ' ' + trip.arrival_station
        });
        choices.push(new inquirer.Separator());
      });

      return inquirer.prompt([
        {
          type: 'list',
          name: 'trip',
          message: 'Available trips:',
          choices: choices,
          pageSize: 20
        }
      ]);
    }).then(answers => {
      let travel_classes = answers.trip;
      if (Object.keys(travel_classes).length > 1) {
        return inquirer.prompt([
          {
            type: 'list',
            name: 'trip_id',
            message: 'Travel class:',
            choices: [
              {
                name: 'Economy: ' + travel_classes.economy.cents/100 + ' ' + travel_classes.economy.currency,
                value: travel_classes.economy.trip_id
              },
              {
                name: 'First: ' + travel_classes.first.cents/100 + ' ' + travel_classes.first.currency,
                value: travel_classes.first.trip_id
              }
            ]
          }
        ])
      } else {
        return Promise.resolve({trip_id: travel_classes[Object.keys(travel_classes)[0]].trip_id});
      }
    }).then(trip => {
      console.log(trip);
    });
  }
}

/**
 * Adapt a list of trips from a search
 * for an easy display. Compute the list of stops from the list of segments.
 * @param {trips} array({})
 * @return array({})
 */
function humanifyTrips(trips) {
  trips.forEach(trip => {
    trip.stops = [];
    for (let i = 1; i < trip.segments.length; i++) {
      let segment = trip.segments[i];
      let psegment = trip.segments[i-1];
      let stop = {
        station: segment.departure_station,
        train_name: segment.train_name,
        duration: (moment(segment.departure_date) - moment(psegment.arrival_date))
      };
      trip.stops.push(stop);
    }
  });

  return trips;
};

/**
 * Format for a human the duration in seconds
 * @param {duration} number The duration in ms
 * @return string
 */
function formatDuration(duration) {
  function fillz(n) {
    if (n < 10) {
      return '0' + n;
    }
    return n;
  }
  duration = duration/1000;
  let o = '';
  if ((duration % 3600) != 0) {
    o = Math.ceil((duration%3600)/60);
  }
  if (duration >= 3600) {
    o = Math.floor(duration/3600) + 'h' + fillz(o);
  } else {
    o += ' min';
  }
  return o;
}

/**
 * Return the next `limit` days, to a human format
 * @param {limit} number The number of days to return
 * @return array(string)
 */
function getNextDays(limit) {
  let dates = [];
  let currentDate = moment();
  for (let i = 0; i < limit; i++) {
    let d = currentDate.format('dddd, MMMM D');
    if (currentDate.isoWeekday() >= 6) {
      d = colors.green(d);
    }
    if (i <= 1) {
      d = colors.bold(d);
    }
    dates.push(d);
    currentDate.add(1, 'days');
  }
  return dates;
}

/**
 * Search for a station
 * If no query, return the most popular stations of the user
 * @param {answers} array The previous answers
 * @param {input} string The query
 * @return Promise([string])
 */
function searchStation(answers, input) {
  return (function() {
    if (input) {
      return trainline.searchStation(input);
    }
    return Promise.resolve(uinfos.stations);
  }()).then(stations => {
    return stations.map(s => s.name);
  });
}

/**
 * Create a table for display from an array of trips
 * @param {trips} array List of trips
 * @return string The table to display
 */
function tripsToTable(trips) {
  let table = new Table({
    style: { 'padding-left': 0 }
  });

  trips.forEach(trip => {
    let reference = trip.reference;

    let departure_date = moment(trip.departure_date).calendar();
    let arrival_date = moment(trip.arrival_date).calendar();
    let date = departure_date;
    if (departure_date != arrival_date) {
      date += '\n' + arrival_date;
    }

    let stations = trip.departure_station.name + '\n' + trip.arrival_station.name;

    let passenger = trip.passenger.first_name;

    let price = {hAlign: 'right', content: trip.cents/100 + ' ' + trip.currency};

    table.push([reference, date, stations, passenger, price]);
  });

  return table.toString();
}
