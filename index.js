var elasticsearch = require('elasticsearch');
var async = require('async');
var _ = require('lodash');

module.exports = {
  afterConstruct: function(self, callback) {
    self.addIndexTask();
    return async.series([
      self.connect,
      self.ensureIndexes
    ], callback);
  },
  construct: function(self, options) {
    self.fields = (self.options.fields || [ 'title', 'tags', 'type', 'lowSearchWords', 'highSearchWords' ]).concat(self.options.addFields || []);
    self.apos.define('apostrophe-cursor', require('./lib/cursor.js'));
    self.connect = function(callback) {
      self.baseName = self.options.baseName || self.apos.shortName;
      // Index names are restricted to lowercase letters
      self.docIndex = self.baseName.toLowerCase() + 'aposdocs';
      var host;
      var esOptions = (self.options.elasticsearchOptions || {});
      if (self.options.port) {
        host = (self.options.host || 'localhost') + ':' + self.options.port;
      } else {
        // Common convention with elasticsearch is one string with both host and port
        host = self.options.host || 'localhost:9200';
      }
      esOptions.host = esOptions.host || host;

      self.client = new elasticsearch.Client(esOptions);
      return self.client.ping({
        requestTimeout: 5000
      }, callback);
    };
    self.ensureIndexes = function(callback) {
      var workflow = self.apos.modules['apostrophe-workflow'];
      var locales = workflow ? _.keys(workflow) : [ 'default' ];
      return async.eachSeries(locales, function(locale, callback) {
        return self.client.indices.create({
          index: self.getLocaleIndex(locale),
          body: {
            mappings: {
              aposDoc: {
                properties: {
                  tags: {
                    type: 'keyword'
                  },
                  type: {
                    type: 'keyword'
                  },
                  __id: {
                    type: 'keyword'
                  },
                  slug: {
                    type: 'keyword'
                  },
                  path: {
                    type: 'keyword'
                  }
                }
              }
            }
          }
        }, callback);
      }, callback);
    }
    self.docBeforeSave = function(req, doc, options, callback) {
      var body = {};
      _.each(self.fields, function(field) {
        body[field] = doc[field];
      })
      var toIndex = {
        id: doc._id,
        // Why is this necessary at all?
        type: 'aposDoc',
        refresh: options.elasticsearchDefer ? false : true,
        body: body
      };
      // No idea why it isn't cool to have this in the body too
      delete toIndex.body._id;
      if (doc.workflowLocale) {
        return self.client.index(_.assign({
          index: self.getLocaleIndex(doc.workflowLocale)
        }, toIndex), callback);
      } else {
        // Not locale specific, so must appear in all locale indexes
        var locales = [ 'default' ];
        var workflow = self.apos.modules['apostrophe-workflow'];
        if (workflow) {
          locales = _.keys(workflow.locales);
        }
        return async.eachLimit(locales, 5, function(locale, callback) {
          return self.client.index(_.assign({
            index: self.getLocaleIndex(locale)
          }, toIndex), callback);
        }, callback);
      }
    };
    self.indexNamesSeen = {};
    self.getLocaleIndex = function(locale) {
      locale = locale.toLowerCase();
      var indexName = self.docIndex + locale.replace(/[^a-z]/g, '');
      if (self.indexNamesSeen[indexName] && (self.indexNamesSeen[indexName] !== locale)) {
        throw new Error('apostrophe-elasticsearch: the locale names ' + locale + ' and ' + self.indexNamesSeen[indexName] + ' cannot be distinguished purely by their lowercased letters. elasticsearch allows no other characters in index names.');
      }
      self.indexNamesSeen[indexName] = locale;
      return indexName;
    };
    self.addIndexTask = function() {
      return self.addTask('index', 'Usage: node app apostrophe-elasticsearch:index\n\nYou should only need this task once under normal conditions.', self.indexTask);
    };
    self.indexTask = function(apos, argv, callback) {
      var req = self.apos.tasks.getReq();
      return async.series([
        index,
        refresh
      ], callback);
      function index(callback) {
        return self.apos.migrations.eachDoc({}, function(doc, callback) {
          return self.docBeforeSave(req, doc, { elasticsearchDefer: true }, callback);
        }, callback);
      }
      function refresh(callback) {
        return self.client.indices.refresh({ index: self.docIndex }, callback);
      }
    };
  }
};
