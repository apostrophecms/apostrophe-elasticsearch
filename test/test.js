const assert = require('assert');
const _ = require('lodash');

describe('apostrophe-elasticsearch: ', function() {

  let apos = null;

  this.timeout(20000);

  after(function(done) {
    try {
      require('apostrophe/test-lib/util').destroy(apos, done);
    } catch (e) {
      console.warn('Old version of apostrophe does not export test-lib/util library, just dropping old test db');
      apos.db.dropDatabase();
      setTimeout(done, 1000);
    }
  });

  it('should be a property of the apos object', function(done) {
    apos = require('apostrophe')({
      testModule: true,
      baseUrl: 'http://localhost:7780',
      modules: {
        'apostrophe-express': {
          port: 7780
        },
        'apostrophe-elasticsearch': {
        },
        'apostrophe-pages': {
          park: [
            {
              title: 'Tab One',
              type: 'default',
              slug: '/tab-one',
              _children: [
                {
                  title: 'Tab One Child One',
                  type: 'default',
                  slug: '/tab-one/child-one'
                },
                {
                  title: 'Tab One Child Two',
                  type: 'default',
                  slug: '/tab-one/child-two'
                }
              ]
            },
            {
              title: 'Tab Two',
              type: 'default',
              slug: '/tab-two',
              _children: [
                {
                  title: 'Tab Two Child One',
                  type: 'default',
                  slug: '/tab-two/child-one'
                },
                {
                  title: 'Tab Two Child Two',
                  type: 'default',
                  slug: '/tab-two/child-two'
                }
              ]
            },
            {
              title: 'Products',
              type: 'products-page',
              slug: '/products'
            }
          ],
          types: [
            {
              name: 'home',
              label: 'Home'
            },
            {
              name: 'default',
              label: 'Default'
            },
            {
              name: 'products',
              label: 'Products'
            }
          ]
        },
        'products': {
          extend: 'apostrophe-pieces',
          name: 'product',
          alias: 'products',
          construct: function(self, options) {
            self.generate = function(i) {
              let piece = self.newInstance();
              // one word for ease of search test
              piece.title = 'product' + (i + 1);
              piece.age = i % 10;
              piece.body = {
                type: 'area',
                items: [
                  {
                    _id: apos.utils.generateId(),
                    type: 'apostrophe-rich-text',
                    // everybody gets calligraphy, 50% get stenography
                    content: '<h4>calligraphy ' + ((i & 1) ? 'stenography' : '') + '</h4>'
                  }
                ]
              };
              piece.published = true;
              return piece;
            };
          }
        },
        'products-pages': {
          extend: 'apostrophe-pieces-pages'
        }
      },
      afterInit: function(callback) {
        assert(apos.modules['apostrophe-elasticsearch']);
        assert(apos.modules['apostrophe-elasticsearch'].refresh);
        return callback(null);
      },
      afterListen: function(err) {
        assert(!err);
        done();
      }
    });
  });

  it('reindex to remove old test cases', function() {
    return apos.tasks.invoke('apostrophe-elasticsearch:reindex', { verbose: true });
  });

  it('insert many products for test purposes', function() {
    return apos.tasks.invoke('products:generate', { total: 100 });
  });

  it('insert an unpublished product for test purposes', function() {
    let product = _.assign(apos.modules.products.newInstance(), {
      title: 'Unpublished',
      slug: 'unpublished',
      published: false
    });
    return apos.modules.products.insert(apos.tasks.getReq(), product);
  });

  it('search for one product', function() {
    const req = apos.tasks.getAnonReq();
    const cursor = apos.products.find(req, {}).search('product50');
    return cursor.toArray().then(function(products) {
      assert(products);
      assert(products.length === 1);
      assert(products[0].title === 'product50');
      // Make sure elasticsearch is in use
      assert(cursor.get('elasticsearch'));
    });
  });

  it('no search (return everything) if search parameter is null', function() {
    const req = apos.tasks.getAnonReq();
    const cursor = apos.products.find(req, {}).search(null);
    return cursor.toArray().then(function(products) {
      assert(products);
      assert(products.length === 100);
      // Make sure elasticsearch is not in use
      assert(!cursor.get('elasticsearch'));
    });
  });

  it('no search (return everything) if search parameter is undefined', function() {
    const req = apos.tasks.getAnonReq();
    const cursor = apos.products.find(req, {}).search(undefined);
    return cursor.toArray().then(function(products) {
      assert(products);
      assert(products.length === 100);
      // Make sure elasticsearch is not in use
      assert(!cursor.get('elasticsearch'));
    });
  });

  it('no search (return everything) if search parameter is empty string', function() {
    const req = apos.tasks.getAnonReq();
    const cursor = apos.products.find(req, {}).search('');
    return cursor.toArray().then(function(products) {
      assert(products);
      assert(products.length === 100);
      // Make sure elasticsearch is not in use
      assert(!cursor.get('elasticsearch'));
    });
  });

  it('search for unpublished product should fail', function() {
    const req = apos.tasks.getAnonReq();
    return apos.products.find(req, {}).search('unpublished').toArray().then(function(products) {
      assert(products);
      assert(products.length === 0);
    });
  });

  it('search for unpublished product should fail with published(false) if we lack the permissions', function() {
    const req = apos.tasks.getAnonReq();
    return apos.products.find(req, {}).search('unpublished').published(false).toArray().then(function(products) {
      assert(products);
      assert(products.length === 0);
    });
  });

  it('search for unpublished product should succeed with published(false) if we have the permissions', function() {
    const req = apos.tasks.getReq();
    return apos.products.find(req, {}).search('unpublished').published(false).toArray().then(function(products) {
      assert(products);
      assert(products.length === 1);
      assert(products[0].published === false);
      assert(products[0].title === 'Unpublished');
    });
  });

  it('can get everything', function() {
    const req = apos.tasks.getAnonReq();
    return apos.products.find(req).search('calligraphy').toArray().then(function(docs) {
      assert(docs);
      assert(docs.length === 100);
    });
  });

  it('can get 50%', function() {
    const req = apos.tasks.getAnonReq();
    return apos.products.find(req).search('stenography').toArray().then(function(docs) {
      assert(docs);
      assert(docs.length === 50);
    });
  });

  it('can paginate the 50% properly', function() {
    const req = apos.tasks.getAnonReq();
    let i = 0;
    let titlesSeen = {};
    return testNextBatch();
    function testNextBatch() {
      return apos.products.find(req).search('stenography').skip(i).limit(5).toArray().then(function(docs) {
        assert(docs);
        assert(docs.length === 5);
        _.each(docs, function(doc) {
          assert(!titlesSeen[doc.title]);
          titlesSeen[doc.title] = true;
        });
        i += 5;
        if (i === 50) {
          assert(_.keys(titlesSeen).length === 50);
          return;
        }
        return testNextBatch();
      });
    }
  });

  it('unrelated queries work properly', function() {
    const req = apos.tasks.getAnonReq();
    return apos.products.find(req, { title: 'product50' }).toObject().then(function(product) {
      assert(product);
      assert(product.title === 'product50');
    });
  });

  it('distinct works properly', function() {
    const req = apos.tasks.getReq();
    return apos.products.find(req).search('calligraphy').toDistinct('age').then(function(ages) {
      assert(ages);
      assert(ages.length === 10);
      for (let i = 0; (i < 10); i++) {
        assert(_.find(ages, function(age) {
          return age === i;
        }) !== undefined);
      }
    });
  });

  it('distinct works properly with counts', function() {
    const req = apos.tasks.getReq();
    const cursor = apos.products.find(req).search('calligraphy').distinctCounts(true);
    return cursor.toDistinct('age').then(function(ages) {
      assert(ages);
      assert(ages.length === 10);
      for (let i = 0; (i < 10); i++) {
        assert(_.find(ages, function(age) {
          return age === i;
        }) !== undefined);
      }
      let counts = cursor.get('distinctCounts');
      for (let i = 0; (i < 10); i++) {
        assert(counts[i] === 10);
      }
    });
  });

  it('safeQuery detects all arguments that do not convert to nonempty strings', function() {
    const module = apos.modules['apostrophe-elasticsearch'];
    const values = [ null, undefined, false, true, 0, '0', 1, '1', '' ];

    for (const s of values) {
      try {
        const string = s.toString();
        if (string.length) {
          assert(module.safeQuery(s));
        } else {
          assert(!module.safeQuery(s));
        }
      } catch (e) {
        assert(!module.safeQuery(s));
      }
    } 

  });

});
