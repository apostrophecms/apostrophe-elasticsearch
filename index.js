const elasticsearch = require('elasticsearch');
const async = require('async');
const _ = require('lodash');

module.exports = {
  afterConstruct: function(self, callback) {
    self.addReindexTask();
    return self.connect(callback);
  },
  construct: function(self, options) {
    self.fields = (self.options.fields || [ 'title', 'slug', 'path', 'tags', 'type', 'lowSearchText', 'highSearchText' ]).concat(self.options.addFields || []);
    // Mandatory because the query engine does exact matches on them
    // for performance
    const mandatoryFields = [ 'slug', 'path', 'type', 'tags' ];
    self.fields = self.fields.concat(mandatoryFields);
    self.fields = _.uniq(self.fields);
    self.apos.define('apostrophe-cursor', require('./lib/cursor.js'));
    self.connect = function(callback) {
      self.baseName = self.options.baseName || self.apos.shortName;
      // Index names are restricted to lowercase letters
      self.docIndex = self.baseName.toLowerCase() + 'aposdocs';
      let host = null;
      self.esOptions = (self.options.elasticsearchOptions || {});
      if (self.options.port) {
        host = (self.options.host || 'localhost') + ':' + self.options.port;
      } else {
        // Common convention with elasticsearch is one string with both host and port
        host = self.options.host || 'localhost:9200';
      }
      self.esOptions.host = self.esOptions.host || host;
      self.esOptions.apiVersion = self.esOptions.apiVersion || '6.4';

      self.client = new elasticsearch.Client(self.esOptions);
      return self.client.ping({
        requestTimeout: 5000
      }, callback);
    };

    self.docAfterSave = function(req, doc, options, callback) {
      const args = {
        body: self.getBulkIndexCommandsForDoc(req, doc, options),
        refresh: (!options.elasticsearchDefer).toString()
      };
      return self.client.bulk(args, callback);
    };

    // Return an array of parameters to `self.client.bulk` to
    // index the doc in question. There could be just one index
    // action description and one document body, or there could be
    // many such pairs, depending on workflow requirements.

    self.getBulkIndexCommandsForDoc = function(req, doc, options) {
      const commands = [];
      const body = {};
      _.each(self.fields, function(field) {
        const value = doc[field];
        let good = false;
        if (Array.isArray(value)) {
          if ((typeof value[0]) !== 'object') {
            good = true;
          }
        } else if ((typeof value) !== 'object') {
          good = true;
        }
        if (good) {
          body[field] = doc[field];
          // Allow exact matches of fields too without as much overthinking
          // of types, but don't redundantly store the 'exact' value where
          // it's too large to be requested that way anyway
          if (((!doc[field]) || JSON.stringify(doc[field]).length < 4096)) {
            body[field + 'ESExact'] = doc[field];
          }
        }
      });
      // No idea why it isn't cool to have this in the body too,
      // but ES flips out
      delete body._id;
      const locale = options.effectiveLocale || doc.workflowLocale;
      if (locale) {
        commands.push({
          index: {
            _index: self.getLocaleIndex(locale),
            _type: 'aposDoc',
            _id: doc._id
          }
        });
        commands.push(body);
      } else {
        // Not locale specific, so must appear in all locale indexes
        let locales = [ 'default' ];
        const workflow = self.apos.modules['apostrophe-workflow'];
        if (workflow) {
          locales = _.keys(workflow.locales);
        }
        _.each(locales, function(locale) {
          commands.push({
            index: {
              _index: self.getLocaleIndex(locale),
              _type: 'aposDoc',
              _id: doc._id
            }
          });
          commands.push(body);
        });
      }
      return commands;
    };

    self.indexNamesSeen = {};
    self.getLocaleIndex = function(locale) {
      locale = locale.toLowerCase();
      const indexName = self.docIndex + locale.replace(/[^a-z]/g, '');
      if (self.indexNamesSeen[indexName] && (self.indexNamesSeen[indexName] !== locale)) {
        throw new Error('apostrophe-elasticsearch: the locale names ' + locale + ' and ' + self.indexNamesSeen[indexName] + ' cannot be distinguished purely by their lowercased letters. elasticsearch allows no other characters in index names.');
      }
      self.indexNamesSeen[indexName] = locale;
      return indexName;
    };
    self.addReindexTask = function() {
      return self.addTask('reindex', 'Usage: node app apostrophe-elasticsearch:reindex\n\nYou should only need this task once under normal conditions.', self.reindexTask);
    };

    self.reindexTask = function(apos, argv, callback) {
      self.verbose('reindex task launched');
      return self.apos.locks.withLock('apostrophe-elasticsearch-reindex', function(callback) {
        return async.series([
          self.dropIndexes,
          self.createIndexes,
          self.index,
          self.refresh
        ], callback);
      });
    };

    // Drop all indexes. Called by the reindex task, otherwise not needed

    self.dropIndexes = function(callback) {
      self.verbose('dropping indexes');
      return self.client.cat.indices({
        h: ['index']
      }, function(err, result) {
        if (err) {
          return callback(err);
        }
        // Strange return format
        let indexes = (result || '').split(/\n/);
        indexes = _.filter(indexes, function(index) {
          return index.substr(0, self.docIndex.length) === self.docIndex;
        });
        if (!indexes.length) {
          return callback(null);
        }
        return self.client.indices.delete({
          index: indexes
        }, callback);
      });
    };

    self.getLocales = function() {
      const workflow = self.apos.modules['apostrophe-workflow'];
      return workflow ? _.keys(workflow.locales) : [ 'default' ];
    };

    // Create all indexes. Called by the reindex task, otherwise not needed
    self.createIndexes = function(callback) {
      self.verbose('creating indexes');
      const locales = self.getLocales();
      return async.eachSeries(locales, function(locale, callback) {
        const properties = {};
        _.each(self.fields, function(field) {
          properties[field] = {
            type: 'text'
          };
          properties[field + 'ESExact'] = {
            type: 'keyword'
          };
        });
        return self.client.indices.create({
          index: self.getLocaleIndex(locale),
          body: {
            settings: self.getLocaleSettings(locale),
            mappings: {
              aposDoc: {
                properties: properties
              }
            }
          }
        }, callback);
      }, callback);
    };

    self.getLocaleSettings = function(locale) {
      locale = locale.replace(/-draft$/, '');
      const settings = {};
      _.merge(settings, self.options.indexSettings || {});
      if (self.options.analyzer) {
        _.merge(settings, {
          'analysis': {
            'analyzer': self.options.analyzer
          }
        });
      }
      _.merge(settings, (self.options.localeIndexSettings || {})[locale] || {});
      if (self.options.analyzers && self.options.analyzers[locale]) {
        _.merge(settings, {
          'analysis': {
            'analyzer': self.options.analyzers[locale]
          }
        });
      }
      return settings;
    };

    // Index all documents. Called by the reindex task, otherwise not needed
    self.index = function(callback) {
      const batchSize = self.options.batchSize || 1000;
      const req = self.apos.tasks.getReq();
      self.verbose('Indexing all documents');
      const workflow = self.apos.modules['apostrophe-workflow'];
      const locales = (workflow && _.keys(workflow.locales)) || [ null ];
      const start = Date.now();
      let li = 0;
      return async.eachSeries(locales, processLocale, callback);

      function processLocale(locale, callback) {
        let reindexed = 0;
        let last = '';
        let count;

        self.verbose(locale + ': counting docs for progress display');
        return self.apos.docs.db.count({
          $or: [
            {
              workflowLocale: locale
            },
            {
              // docs with no locale must be indexed with every locale
              workflowLocale: null
            }
          ]
        }, function(err, _count) {
          if (err) {
            return callback(err);
          }
          count = _count;
          // Do the next batch, recursively
          return nextBatch(callback);
        });
        function nextBatch(callback) {
          // const start = Date.now();
          return self.apos.docs.db.find({
            $or: [
              {
                workflowLocale: locale
              },
              {
                // docs with no locale must be indexed with every locale
                workflowLocale: null
              }
            ],
            _id: { $gt: last }
          }).sort({ _id: 1 }).limit(batchSize).toArray(function(err, docs) {
            // const end = Date.now();
            if (err) {
              return callback(err);
            }
            if (!docs.length) {
              // This is how we terminate successfully
              li++;
              return callback(null);
            }
            const lastDoc = docs[docs.length - 1];
            last = lastDoc._id;
            // const iStart = Date.now();
            return indexBatch(docs, function(err) {
              // const iEnd = Date.now();
              if (err) {
                return callback(err);
              }
              // self.verbose('locale: ' + locale + ' last: ' + last + ' fetch: ' + (end - start) + ' index: ' + (iEnd - iStart));
              return nextBatch(callback);
            });
          });
        }
        function indexBatch(docs, callback) {
          reindexed += docs.length;
          const portion = (li / locales.length) + (reindexed / count * (1 / locales.length));
          const percent = Math.floor(portion * 100 * 100) / 100;
          const time = ((Date.now() - start) / portion);
          const remaining = time - (Date.now() - start);
          const localeLabel = locale ? `${locale}: ` : '';
          self.verbose(`${localeLabel}indexed ${reindexed} of ${count}, locale ${li + 1} of ${locales.length} (${percent}%) (${formatTime(remaining)} remaining)`);
          const args = {
            body: _.flatten(
              _.map(docs, function(doc) {
                return self.getBulkIndexCommandsForDoc(req, doc, {
                  effectiveLocale: locale
                });
              })
            )
          };
          return self.client.bulk(args, function(err) {
            if (err && (err.code === 'ECONNRESET')) {
              self.verbose('ECONNRESET, trying a new connection');
              self.client = new elasticsearch.Client(self.esOptions);
              return indexBatch(docs, callback);
            }
            if (err && self.errorIsSplittable(err) && (docs.length > 1)) {
              // Slice and dice until we get through
              self.verbose(err.statusCode + ' suggests too big, splitting up this batch, if you see this a lot reduce batchSize option');
              const pivot = Math.floor(docs.length / 2);
              const batches = [
                docs.slice(0, pivot),
                docs.slice(pivot)
              ];
              return async.eachSeries(batches, indexBatch, callback);
            }
            return callback(err);
          });
        }
        function formatTime(ms) {
          ms /= 1000;
          ms /= 60;
          ms = Math.floor(ms);
          const hours = Math.floor(ms / 60);
          const minutes = ms - (hours * 60);
          return `${hours}h${minutes}m`;
        }
      }

    };

    self.errorIsSplittable = function(err) {
      return (err.statusCode === 413) || (err.statusCode === 408);
    };

    // Refresh the index (commit it so it can be used). Called by the reindex task
    // once at the end for efficiency
    self.refresh = function(callback) {
      self.verbose('refreshing');
      const locales = self.getLocales();
      const indexes = _.map(locales, self.getLocaleIndex);
      return self.client.indices.refresh({ index: indexes }, callback);
    };

    self.verbose = function(s) {
      if (self.apos.argv.verbose || self.options.verbose) {
        self.apos.utils.info(self.__meta.name + ': ' + s);
      }
    };
  }
};
