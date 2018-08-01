var elasticsearch = require('elasticsearch');
var async = require('async');
var _ = require('lodash');

module.exports = {
  afterConstruct: function(self, callback) {
    self.addIndexTask();
    return self.connect(callback);
  },
  construct: function(self, options) {
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
    self.docBeforeSave = function(req, doc, options, callback) {
      var toIndex = {
        index: self.docIndex,
        id: doc._id,
        // Why is this necessary?
        type: 'aposDoc',
        refresh: options.elasticsearchDefer ? false : true,
        // ES will bomb if _id is in the body
        body: _.omit(self.apos.utils.clonePermanent(doc), '_id')
      };
      return self.client.index(toIndex, callback);
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
